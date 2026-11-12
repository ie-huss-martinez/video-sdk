import { createWorkerClient, type WorkerClient } from "@hussmartinez/sdk-core";
import { asVideoError } from "../core/errors/error-helpers.js";
import { VideoError } from "../core/errors/video-error.js";
import { type VideoFilePolicy, videoLimits } from "../core/errors/video-limits.js";
import { planFrames, type VideoPlan } from "../core/model/plan.js";
import { frameTime } from "../core/model/time.js";
import { checkedBackingSize } from "../core/playback/backing.js";
import type { SchedulerCommand } from "../core/playback/scheduler.js";
import {
  clipStarts,
  frameAt,
  mediaTimeAt,
  type PlaybackAnchor,
  stepTarget,
} from "../core/playback/timeline.js";
import type { VideoEngine } from "../core/ports/video-engine.js";
import type {
  VideoOutput,
  VideoOutputSnapshot,
  VideoOutputState,
} from "../core/ports/video-output.js";
import type { MediaWorkerContract, PlaybackSource } from "./media-worker/contract.js";
import { type AudioEnvironment, createPlaybackAudio } from "./playback-audio.js";
import { engineInternals } from "./video-engine.js";

/**
 * Options for {@link createVideoOutput}.
 *
 * @public
 */
export interface VideoOutputOptions {
  /** The engine whose open sources the output plays: one made by `createVideoEngine`. */
  readonly engine: VideoEngine;
  /**
   * The canvas to draw into. It's transferred to the output's worker, so the
   * page can't draw into it or transfer it again. It's drawn at the width
   * and height it has when the output is created, until `resize` sets
   * them; style it to fit the stage.
   */
  readonly canvas: HTMLCanvasElement;
  /**
   * The limits `resize` checks the canvas's backing size against:
   * `maxFramePixels`. The defaults of `videoLimits` when omitted.
   */
  readonly filePolicy?: VideoFilePolicy;
}

/** How often the page sends the anchor while playing, and learns of dropped frames and failures (docs/adr/0006). */
const ANCHOR_INTERVAL = 250;

/** The playback worker, as the output uses it. */
type PlaybackCall = <Method extends "resize" | "audio" | "load" | "control">(
  method: Method,
  input: MediaWorkerContract[Method]["input"],
) => Promise<MediaWorkerContract[Method]["output"]>;

/**
 * What the output needs from its environment, replaceable in tests with a
 * fake worker, a fake clock and a fake page.
 *
 * @internal
 */
export interface OutputEnvironment {
  /** Starts the playback worker with the canvas, and returns how to call it and stop it. */
  readonly connect: () => { readonly call: PlaybackCall; readonly destroy: () => void };
  /** An open source's file, probe and policy, or `undefined`. */
  readonly source: (id: string) => PlaybackSource | undefined;
  /** Wall-clock milliseconds since the epoch, as the worker reads them. */
  readonly now: () => number;
  /** The limits `resize` checks against. */
  readonly policy: VideoFilePolicy;
  /** The page's audio, where there's an `AudioContext`. Without it, playback is silent, on the performance clock. */
  readonly audio?: Omit<AudioEnvironment, "fetchWindow">;
  /** Whether the page is hidden, and how to learn when that changes, if there's a page. */
  readonly visibility?: {
    readonly hidden: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
  };
}

/**
 * Creates the SDK's playback output (docs/adr/0005, docs/adr/0006). It plays
 * the sources open in `engine` into `canvas`, which it transfers to a media
 * worker of its own: frames are decoded and drawn there, and never reach the
 * page. Audio is mixed in the same worker and played through an
 * `AudioContext` created on the first `play`, which is the clock; a plan
 * without audio plays on the performance clock. When the browser's autoplay
 * rules keep the context suspended, playback goes on silently and the
 * snapshot's `audio` is `"blocked"`, until a `play` from a user gesture.
 *
 * Throws `TypeError` for an engine `createVideoEngine` didn't make, and for a
 * canvas that has already been transferred; `VideoError` with
 * `UNSUPPORTED_ENVIRONMENT` without `transferControlToOffscreen`. Destroy it
 * when its canvas unmounts.
 *
 * @example
 * ```ts
 * const output = createVideoOutput({ engine, canvas });
 * output.load(session.getSnapshot().plan);
 * await output.play();
 * ```
 *
 * @public
 */
export function createVideoOutput(options: VideoOutputOptions): VideoOutput {
  const internals = engineInternals(options.engine);
  if (!internals) {
    throw new TypeError(
      "createVideoOutput plays sources from an engine made by createVideoEngine.",
    );
  }
  const { canvas } = options;
  if (typeof canvas.transferControlToOffscreen !== "function") {
    throw new VideoError("UNSUPPORTED_ENVIRONMENT", "This browser can't draw in workers.", {
      details: { feature: "transferControlToOffscreen" },
    });
  }
  let offscreen: OffscreenCanvas;
  try {
    offscreen = canvas.transferControlToOffscreen();
  } catch (cause) {
    throw new TypeError("The canvas has already been transferred.", { cause });
  }
  const wallClock = () => performance.timeOrigin + performance.now();
  return createOutput({
    connect() {
      let client: WorkerClient<MediaWorkerContract> | undefined;
      let destroyed = false;
      const ready = internals.loadWorker().then((start) => {
        if (destroyed) throw new Error("The video output has been destroyed.");
        client = createWorkerClient<MediaWorkerContract>({
          createWorker: start,
          errorClasses: { VideoError },
          // The worker holds the canvas: it lives as long as the output.
          idleTimeout: 0,
        });
        const attached = client.call("attach", { canvas: offscreen }, { transfer: true });
        return { client, attached };
      });
      return {
        call: (method, input) =>
          ready.then(async ({ client: started, attached }) => {
            await attached;
            return started.call(method, input);
          }),
        destroy() {
          destroyed = true;
          client?.destroy();
        },
      };
    },
    source: internals.source,
    now: wallClock,
    policy: options.filePolicy ?? videoLimits.resolve(),
    ...(typeof AudioContext === "undefined"
      ? {}
      : {
          audio: {
            createContext: () => new AudioContext(),
            timeOrigin: performance.timeOrigin,
            performanceNow: () => performance.now(),
          },
        }),
    ...(typeof document === "undefined"
      ? {}
      : {
          visibility: {
            hidden: () => document.visibilityState === "hidden",
            subscribe(listener: () => void) {
              document.addEventListener("visibilitychange", listener);
              return () => document.removeEventListener("visibilitychange", listener);
            },
          },
        }),
  });
}

/**
 * The output, with its environment passed in. The page owns the clock: it
 * knows the playhead from the anchor without a message per frame, decides
 * when playback ends, and tells the worker what to draw.
 *
 * @internal
 */
export function createOutput(environment: OutputEnvironment): VideoOutput {
  const listeners = new Set<() => void>();
  const endedListeners = new Set<() => void>();
  let snapshot: VideoOutputSnapshot = {
    state: "stopped",
    droppedFrames: 0,
    error: null,
    audio: "ready",
  };
  let plan: VideoPlan | undefined;
  let length = 0;
  let duration = 0;
  /** The playhead while not playing, in output frames. */
  let playhead = 0;
  /** The clock while playing. */
  let anchor: PlaybackAnchor | null = null;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let anchorTimer: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let worker: ReturnType<OutputEnvironment["connect"]> | undefined;
  /** Settles when the worker has the latest plan. */
  let loaded: Promise<unknown> = Promise.resolve();
  /** Bumped by everything that stops or restarts the clock, so a start that's overtaken gives up. */
  let starting = 0;
  const player = environment.audio
    ? createPlaybackAudio({
        ...environment.audio,
        fetchWindow: async (from, count, sampleRate) =>
          (await connection().call("audio", { from, count, rate: sampleRate })).channels,
      })
    : undefined;
  const unsubscribeVisibility = environment.visibility?.subscribe(() => onVisibility());

  const assertAlive = () => {
    if (destroyed) throw new Error("The video output has been destroyed.");
  };
  const update = (patch: Partial<VideoOutputSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (
      next.state === snapshot.state &&
      next.droppedFrames === snapshot.droppedFrames &&
      next.error === snapshot.error &&
      next.audio === snapshot.audio
    ) {
      return;
    }
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const connection = () => {
    worker ??= environment.connect();
    return worker;
  };
  const clock = () =>
    anchor ? mediaTimeAt(anchor, environment.now()) : frameTime(playhead, rate());
  const rate = () => plan?.output.frameRate ?? { num: 30, den: 1 };
  const position = () => (anchor && plan ? Math.min(frameAt(plan, clock()), length) : playhead);

  const stopTimers = () => {
    clearTimeout(endTimer);
    clearInterval(anchorTimer);
    endTimer = undefined;
    anchorTimer = undefined;
  };

  /** Playback stopped by a failure: pause where it was, and say why. */
  const fail = (reason: unknown) => {
    if (destroyed) return;
    if (anchor) {
      playhead = position();
      anchor = null;
      stopTimers();
    }
    starting += 1;
    player?.stop();
    update({
      state: snapshot.state === "playing" ? "paused" : snapshot.state,
      error: asVideoError(reason),
    });
  };

  const send = (command: SchedulerCommand): Promise<void> =>
    connection()
      .call("control", command)
      .then(({ droppedFrames }) => {
        if (!destroyed) update({ droppedFrames });
      }, fail);

  /** What the worker should do, from the state: play from the anchor, or show the playhead's frame. */
  const command = (): SchedulerCommand => {
    if (anchor)
      return environment.visibility?.hidden() ? { mode: "hidden" } : { mode: "play", anchor };
    return { mode: "show", at: frameTime(Math.max(0, Math.min(playhead, length - 1)), rate()) };
  };

  /** Ends playback when the clock reaches the end of the plan: stopped there, with `ended` fired once. */
  const watchEnd = () => {
    clearTimeout(endTimer);
    endTimer = setTimeout(
      () => {
        if (!anchor) return;
        if (clock() < duration) return watchEnd();
        playhead = length;
        anchor = null;
        stopTimers();
        player?.stop();
        update({ state: "stopped" });
        void send({ mode: "pause" });
        for (const listener of [...endedListeners]) listener();
      },
      Math.max(0, (duration - clock()) / 1_000),
    );
  };

  /** Whether any clip's source has audio. */
  const hasAudio = () =>
    plan?.clips.some((clip) => environment.source(clip.source)?.probe.audio) ?? false;

  /** Runs the clock from `anchor`: the end, and the anchor every 250 ms, read again from the audio clock. */
  const runClock = (from: PlaybackAnchor) => {
    anchor = from;
    watchEnd();
    clearInterval(anchorTimer);
    anchorTimer = setInterval(() => {
      if (!anchor) return;
      if (player?.stalled()) {
        // The audio stopped keeping time: go on silently from where the clock is.
        player.stop();
        update({ audio: "blocked" });
      } else {
        anchor = player?.anchor() ?? anchor;
      }
      if (!environment.visibility?.hidden()) void send(command());
    }, ANCHOR_INTERVAL);
  };

  /**
   * Starts playing from `frame` (docs/adr/0006): once the worker has drawn
   * that frame, and the first audio windows are ready, the clock starts, so
   * neither starts behind. Audio sets the clock when it can play; otherwise
   * the performance clock does, silently.
   */
  const begin = async (frame: number, waking?: Promise<"running" | "blocked">) => {
    const own = ++starting;
    anchor = null;
    stopTimers();
    player?.stop();
    playhead = frame;
    const overtaken = () =>
      own !== starting || destroyed || (snapshot.state as VideoOutputState) !== "playing";
    await loaded;
    await send({ mode: "show", at: frameTime(Math.min(frame, length - 1), rate()) });
    if (overtaken()) return;
    let from: PlaybackAnchor | undefined;
    if (player && plan && hasAudio()) {
      const audio = await (waking ?? player.start());
      if (overtaken()) return;
      update({ audio: audio === "running" ? "ready" : "blocked" });
      if (audio === "running") from = await player.play(frameTime(frame, rate()), duration);
      if (overtaken()) return player.stop();
    }
    runClock(from ?? { media: frameTime(frame, rate()), at: environment.now() });
    await send(command());
  };

  const onVisibility = () => {
    // Hidden: the worker stops decoding while the clock runs on. Visible
    // again: it resyncs to the clock like a seek (docs/adr/0006). Hidden
    // tabs throttle timers, Chrome's to one a minute after five minutes, so
    // the end is checked again: a clock past it ends playback at once.
    if (destroyed || !anchor) return;
    player?.setHidden(Boolean(environment.visibility?.hidden()));
    watchEnd();
    if (anchor) void send(command());
  };

  /** Stops the clock where it is, keeping the frame drawn. */
  const halt = (state: VideoOutputState) => {
    if (anchor) playhead = position();
    anchor = null;
    starting += 1;
    stopTimers();
    player?.stop();
    update({ state });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    position,
    load(next) {
      assertAlive();
      const at = position();
      const sources = new Map<string, PlaybackSource>();
      for (const clip of next.clips) {
        const source = environment.source(clip.source);
        if (!source) throw new TypeError(`The source "${clip.source}" isn't open in the engine.`);
        sources.set(clip.source, source);
      }
      plan = next;
      length = planFrames(next);
      duration = clipStarts(next).at(-1) as number;
      update({ droppedFrames: 0, error: null });
      loaded = connection()
        .call("load", { plan: next, sources: [...sources.values()] })
        .catch(fail);
      if (anchor && at < length) {
        // The timeline goes on where it is: the clock is unchanged, the
        // worker restarts under the new plan, and audio takes over with the
        // new plan's windows a moment ahead, without a gap.
        watchEnd();
        player?.switchPlan(duration);
      } else {
        if (anchor) halt("stopped");
        playhead = Math.min(at, length);
      }
      if (length > 0) void send(command());
    },
    async play() {
      assertAlive();
      if (length === 0 || snapshot.state === "playing") return;
      update({ state: "playing", error: null });
      // The context is created and resumed now, within the user's gesture:
      // after an await, some browsers no longer count it as one.
      const waking = player && plan && hasAudio() ? player.start() : undefined;
      await begin(playhead >= length ? 0 : playhead, waking);
    },
    pause() {
      assertAlive();
      if (snapshot.state !== "playing") return;
      halt("paused");
      void send({ mode: "pause" });
    },
    stop() {
      assertAlive();
      halt("stopped");
      playhead = 0;
      if (length > 0) void send(command());
    },
    seek(frame) {
      assertAlive();
      const target = Math.max(0, Math.min(Math.round(frame), length));
      update({ error: null });
      if (snapshot.state === "playing" && target < length) {
        void begin(target);
        return;
      }
      if (snapshot.state === "playing") halt("paused");
      playhead = target;
      if (length > 0) void send(command());
    },
    step(delta) {
      assertAlive();
      const target = stepTarget(position(), delta, length);
      if (target === undefined) return;
      if (snapshot.state === "playing") halt("paused");
      playhead = target;
      void send(command());
    },
    resize(width, height, pixelRatio) {
      assertAlive();
      const size = checkedBackingSize(environment.policy, width, height, pixelRatio);
      void connection().call("resize", size).catch(fail);
      // Paused, the frame shown is drawn again, sharp at the new size;
      // playing, the next frame is.
      if (!anchor && length > 0) void send(command());
    },
    on(_event, listener) {
      endedListeners.add(listener);
      return () => endedListeners.delete(listener);
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      stopTimers();
      anchor = null;
      starting += 1;
      unsubscribeVisibility?.();
      await player?.close();
      worker?.destroy();
      update({ state: "stopped" });
      listeners.clear();
      endedListeners.clear();
    },
  };
}
