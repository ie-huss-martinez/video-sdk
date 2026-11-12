import type { WorkerHandlers } from "@hussmartinez/sdk-core";
import { abortError, asVideoError } from "../../core/errors/error-helpers.js";
import { VideoError } from "../../core/errors/video-error.js";
import { videoLimits } from "../../core/errors/video-limits.js";
import type { VideoClip, VideoPlan } from "../../core/model/plan.js";
import type { VideoProbe } from "../../core/model/source.js";
import { type Composition, composeFrame } from "../../core/playback/compose.js";
import { createFrameScheduler } from "../../core/playback/scheduler.js";
import { mediaTimeAt, type PlaybackAnchor } from "../../core/playback/timeline.js";
import { frontCheck } from "../front-check/front-check.js";
import { type FrameReader, openFrameReader } from "../mediabunny/frame-reader.js";
import type { MediaWorkerContract, PlaybackSource } from "./contract.js";

/** The playback methods of the media worker's contract. */
type PlaybackMethods = Pick<MediaWorkerContract, "attach" | "load" | "control">;

/**
 * What a test learns after each frame is drawn: the canvas, the clip, the
 * frame's time in its source, and the clock, so it can read back what was
 * drawn and check it's the frame the plan places at the clock.
 *
 * @internal
 */
export interface DrawnFrame {
  /** The context drawn into. Firefox refuses a second `getContext` on a transferred canvas. */
  readonly context: OffscreenCanvasRenderingContext2D;
  readonly clip: VideoClip;
  /** The frame's time in its source, from the probe's `start`, in microseconds. */
  readonly sourceTime: number;
  /** The clock when it was drawn, in timeline microseconds, or `null` when paused. */
  readonly clock: number | null;
}

/**
 * Options for the playback handlers, for tests.
 *
 * @internal
 */
export interface PlaybackHooks {
  readonly afterDraw?: (drawn: DrawnFrame) => void;
}

/** Wall-clock milliseconds since the epoch, which a page and its workers agree on. */
export function wallClock(): number {
  return performance.timeOrigin + performance.now();
}

function animationFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => {
      cancelAnimationFrame(id);
      reject(abortError(signal));
    };
    const id = requestAnimationFrame(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Paints a composed picture: black outside the output frame, the picture clipped to it. */
function paint(
  context: OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  composition: Composition,
): void {
  const { canvas } = context;
  const { viewport, source } = composition;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.beginPath();
  context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  context.clip();
  context.translate(composition.centerX, composition.centerY);
  context.rotate((composition.rotation * Math.PI) / 180);
  context.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    -composition.width / 2,
    -composition.height / 2,
    composition.width,
    composition.height,
  );
  context.restore();
}

/**
 * The media worker's playback (docs/adr/0006): it draws into the canvas the
 * page transferred, with the frame scheduler as the decoder's consumer.
 * Decoded frames never leave this worker.
 *
 * @internal
 */
export function playbackHandlers(hooks: PlaybackHooks = {}): WorkerHandlers<PlaybackMethods> {
  let context: OffscreenCanvasRenderingContext2D | undefined;
  let sources = new Map<string, PlaybackSource>();
  const readers = new Map<string, { readonly file: Blob; readonly reader: Promise<FrameReader> }>();
  let anchor: PlaybackAnchor | null = null;
  /** Once `drawImage` refuses a frame, every later frame is drawn through an `ImageBitmap`. */
  let throughBitmaps = false;
  let bitmapQueue: Promise<void> = Promise.resolve();

  const readerFor = (id: string): Promise<FrameReader> => {
    const source = sources.get(id);
    if (!source) return Promise.reject(new TypeError(`The source "${id}" isn't loaded.`));
    const open = readers.get(id);
    if (open && open.file === source.file) return open.reader;
    const reader = (async () => {
      // The same front check as a probe, before mediabunny reads the file.
      await frontCheck(source.file, videoLimits.resolve(source.limits));
      return openFrameReader(source.file, source.probe);
    })();
    readers.set(id, { file: source.file, reader });
    reader.catch(() => {
      if (readers.get(id)?.reader === reader) readers.delete(id);
    });
    return reader;
  };

  const drawFrame = (frame: VideoFrame, clip: VideoClip, plan: VideoPlan) => {
    if (!context) return;
    const target = context;
    const probe = sources.get(clip.source)?.probe as VideoProbe;
    const composition = composeFrame(
      plan.output,
      target.canvas,
      {
        width: probe.video.displayWidth,
        height: probe.video.displayHeight,
        rotation: probe.video.rotation,
      },
      clip.transform,
    );
    const drawn: DrawnFrame = {
      context: target,
      clip,
      sourceTime: frame.timestamp - probe.start,
      clock: anchor ? mediaTimeAt(anchor, wallClock()) : null,
    };
    if (!throughBitmaps) {
      try {
        paint(target, frame, composition);
      } catch {
        // This engine refuses to draw a VideoFrame: draw through ImageBitmaps from now on.
        throughBitmaps = true;
      }
      if (!throughBitmaps) {
        hooks.afterDraw?.(drawn);
        return;
      }
    }
    const copy = frame.clone();
    bitmapQueue = bitmapQueue
      .then(async () => {
        const bitmap = await createImageBitmap(copy);
        try {
          paint(target, bitmap, composition);
          hooks.afterDraw?.(drawn);
        } finally {
          bitmap.close();
        }
      })
      .catch(() => {})
      .finally(() => copy.close());
  };

  const scheduler = createFrameScheduler<VideoFrame>({
    now: wallClock,
    animationFrame,
    async decode(id, range, onFrame, signal) {
      return (await readerFor(id)).decode(range, onFrame, signal);
    },
    draw: drawFrame,
  });

  return {
    attach({ canvas }) {
      if (context) throw new TypeError("A canvas is already attached.");
      const attached = canvas.getContext("2d", { alpha: false });
      if (!attached) {
        throw new VideoError("UNSUPPORTED_ENVIRONMENT", "This browser can't draw in workers.", {
          details: { feature: "OffscreenCanvas" },
        });
      }
      context = attached;
      return undefined;
    },
    load({ plan, sources: next }) {
      sources = new Map(next.map((source) => [source.id, source]));
      for (const [id, open] of readers) {
        if (sources.get(id)?.file === open.file) continue;
        readers.delete(id);
        void open.reader.then(
          (reader) => reader.dispose(),
          () => {},
        );
      }
      scheduler.load(plan, new Map(next.map((source) => [source.id, source.probe.start])));
      return undefined;
    },
    async control(command) {
      const earlier = scheduler.takeError();
      if (earlier !== undefined) throw asVideoError(earlier);
      anchor = command.mode === "play" ? command.anchor : null;
      scheduler.control(command);
      if (command.mode === "show") {
        // A paused seek replies once its frame is drawn, so its failure
        // reaches the page; while playing, the next anchor's reply carries it.
        await scheduler.settled();
        const failure = scheduler.takeError();
        if (failure !== undefined) throw asVideoError(failure);
      }
      return { droppedFrames: scheduler.dropped };
    },
  };
}
