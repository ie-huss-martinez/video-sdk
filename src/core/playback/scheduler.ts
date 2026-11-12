import type { VideoClip, VideoPlan } from "../model/plan.js";
import { frameTime } from "../model/time.js";
import {
  clipAt,
  clipStarts,
  mediaTimeAt,
  type PlaybackAnchor,
  PREROLL,
  sameAnchor,
} from "./timeline.js";

/**
 * What the scheduler needs of a decoded frame: a `VideoFrame` has it, and
 * tests pass plain objects.
 *
 * @internal
 */
export interface SchedulerFrame {
  /** The presentation time, in the container's microseconds. */
  readonly timestamp: number;
  clone(): this;
  close(): void;
}

/**
 * Which frames to decode, in the container's microseconds: decoding starts at
 * the key packet at or before `keyFrom`, and frames from `from` up to, but
 * not including, `to` are delivered in presentation order.
 *
 * @internal
 */
export interface SchedulerRange {
  readonly keyFrom: number;
  readonly from: number;
  readonly to: number;
}

/**
 * What the scheduler runs on (docs/adr/0006), replaceable in tests with a fake
 * clock, a fake decoder and a fake surface.
 *
 * @internal
 */
export interface SchedulerEnvironment<Frame extends SchedulerFrame> {
  /** Wall-clock time, in milliseconds since the epoch. */
  now(): number;
  /** Resolves on the next animation frame. Rejects when `signal` aborts. */
  animationFrame(signal: AbortSignal): Promise<void>;
  /**
   * Decodes a range of a source and lends each frame to `onFrame`, which
   * the decoder closes once it settles (docs/adr/0001). Resolves when the
   * range is done, and rejects when `signal` aborts or decoding fails.
   */
  decode(
    source: string,
    range: SchedulerRange,
    onFrame: (frame: Frame) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** Draws a frame of `clip`, composed by the plan. */
  draw(frame: Frame, clip: VideoClip, plan: VideoPlan): void;
}

/**
 * What the page asks the scheduler for (docs/adr/0006).
 *
 * - `play`: draw each frame when the clock reaches its time, from the
 *   clock's position.
 * - `show`: paused, draw the frame at timeline time `at`, in microseconds.
 * - `pause`: stop decoding, and keep the frame drawn.
 * - `hidden`: the page is hidden. Decode and draw nothing, and keep the frame
 *   drawn; the page resyncs with `play` when it's visible again.
 *
 * @internal
 */
export type SchedulerCommand =
  | { readonly mode: "play"; readonly anchor: PlaybackAnchor }
  | { readonly mode: "show"; readonly at: number }
  | { readonly mode: "pause" }
  | { readonly mode: "hidden" };

/**
 * How far a frame's timestamp may be from the time it stands for, in
 * microseconds. WebM and Matroska store timestamps in whole milliseconds by
 * default, so at 30 frames a second frame 80 is stored at 2.667 s, after
 * the 2.666667 s it stands for. A frame within this of the output's frame
 * grid is taken as on it, so seeking and stepping still land on it exactly,
 * and it's drawn neither early nor late.
 *
 * @internal
 */
export const TIMESTAMP_TOLERANCE = 1_000;

/**
 * Counts the clones of frames the scheduler holds, for the tests that prove
 * every frame is closed on every path (docs/adr/0002).
 *
 * @internal
 */
export const schedulerLedger = { held: 0 };

/**
 * The frame scheduler (docs/adr/0006): it is the decoder's consumer, and waits
 * inside it until the clock reaches each frame's time, so the decoder's
 * bounded queues are the only buffering at any length of footage.
 *
 * @internal
 */
export interface FrameScheduler {
  /**
   * Sets the plan, and the time each source's timestamps count from (its
   * probe's `start`). Stops what's running: the page follows with a command.
   */
  load(plan: VideoPlan, starts: ReadonlyMap<string, number>): void;
  /**
   * Runs a command. A `play` whose anchor puts the clock within one output
   * frame of where it is now only corrects the clock, as the audio clock's
   * drift does; it doesn't restart the decoders.
   */
  control(command: SchedulerCommand): void;
  /** Frames skipped while playing since the plan was loaded, because a later one was already due. */
  readonly dropped: number;
  /** The failure that stopped playback, once, or `undefined`. */
  takeError(): unknown;
  /** Resolves when what's running has settled, for tests. */
  settled(): Promise<void>;
  /** Stops, and closes every frame it holds. */
  dispose(): void;
}

/** A clone of a frame the scheduler holds, with its time on the timeline. */
interface Held<Frame> {
  readonly frame: Frame;
  readonly time: number;
  readonly clip: VideoClip;
  /** Whether skipping it counts as a dropped frame: it would have been shown while playing. */
  readonly counted: boolean;
}

/**
 * Creates the frame scheduler over its environment (docs/adr/0006).
 *
 * @internal
 */
export function createFrameScheduler<Frame extends SchedulerFrame>(
  environment: SchedulerEnvironment<Frame>,
): FrameScheduler {
  let plan: VideoPlan | undefined;
  let starts: readonly number[] = [0];
  let sourceStarts: ReadonlyMap<string, number> = new Map();
  let anchor: PlaybackAnchor | null = null;
  let mode: SchedulerCommand["mode"] | undefined;
  let controller: AbortController | undefined;
  /** What's running or still settling after an abort, for {@link FrameScheduler.settled}. */
  const running = new Set<Promise<void>>();
  let dropped = 0;
  let error: unknown;
  /** The latest due frame, waiting for the next animation frame to be drawn. */
  let pending: Held<Frame> | undefined;
  let drawScheduledFor: AbortSignal | undefined;
  /** The time of the frame drawn last, since the last restart: no frame before it is drawn. */
  let lastDrawn = Number.NEGATIVE_INFINITY;

  const hold = (frame: Frame, time: number, clip: VideoClip, counted: boolean): Held<Frame> => {
    schedulerLedger.held += 1;
    return { frame: frame.clone(), time, clip, counted };
  };
  const release = (held: Held<Frame> | undefined) => {
    if (!held) return;
    held.frame.close();
    schedulerLedger.held -= 1;
  };
  const skip = (counted: boolean) => {
    if (counted) dropped += 1;
  };
  const frameDuration = () =>
    plan ? (1_000_000 * plan.output.frameRate.den) / plan.output.frameRate.num : 0;
  /** A time within a clip, snapped to the output's frame grid when it's within the tolerance of it. */
  const onGrid = (time: number) => {
    const rate = (plan as VideoPlan).output.frameRate;
    const grid = frameTime(Math.round((time * rate.num) / (1_000_000 * rate.den)), rate);
    return Math.abs(time - grid) <= TIMESTAMP_TOLERANCE ? grid : time;
  };
  const clock = () =>
    anchor === null ? Number.NEGATIVE_INFINITY : mediaTimeAt(anchor, environment.now());

  /** Draws a frame at once, unless a later one has been drawn; supersedes an older pending one. */
  const drawNow = (
    frame: Frame,
    time: number,
    clip: VideoClip,
    counted: boolean,
    signal: AbortSignal,
  ) => {
    if (signal.aborted || !plan) return;
    if (time < lastDrawn) return skip(counted);
    if (pending && pending.time <= time) {
      skip(pending.counted);
      release(pending);
      pending = undefined;
    }
    environment.draw(frame, clip, plan);
    lastDrawn = time;
  };

  /** Draws whatever frame is pending on the next animation frame. */
  const scheduleDraw = (signal: AbortSignal) => {
    if (drawScheduledFor === signal) return;
    drawScheduledFor = signal;
    environment.animationFrame(signal).then(
      () => {
        if (drawScheduledFor === signal) drawScheduledFor = undefined;
        const due = pending;
        pending = undefined;
        if (due) {
          drawNow(due.frame, due.time, due.clip, false, signal);
          release(due);
        }
      },
      () => {
        if (drawScheduledFor === signal) drawScheduledFor = undefined;
      },
    );
  };

  /** Holds a frame that's already due, to be drawn on the next animation frame unless a later one replaces it. */
  const due = (frame: Frame, time: number, clip: VideoClip, signal: AbortSignal) => {
    if (signal.aborted) return;
    if (time < lastDrawn || (pending && time < pending.time)) return skip(true);
    if (pending) {
      skip(pending.counted);
      release(pending);
    }
    pending = hold(frame, time, clip, true);
    scheduleDraw(signal);
  };

  /** Waits for animation frames until the clock reaches `time`. */
  const until = async (time: number, signal: AbortSignal) => {
    while (clock() < time) await environment.animationFrame(signal);
  };

  /**
   * Decodes one clip from timeline time `from`. The latest frame at or
   * before `from` is drawn first: when the clock reaches `from` while
   * playing, or as soon as it's decoded when showing. While playing, each
   * later frame is then drawn when the clock reaches it.
   */
  const runClip = async (
    index: number,
    from: number,
    playing: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const current = plan as VideoPlan;
    const clip = current.clips[index] as VideoClip;
    const offset = starts[index] as number;
    const origin = sourceStarts.get(clip.source) ?? 0;
    const at = clip.start + (from - offset);
    let first: Held<Frame> | undefined;
    let started = false;
    const publishFirst = async () => {
      started = true;
      if (playing) await until(from, signal);
      if (first) drawNow(first.frame, first.time, clip, false, signal);
      release(first);
      first = undefined;
    };
    try {
      await environment.decode(
        clip.source,
        {
          keyFrom: origin + at + TIMESTAMP_TOLERANCE,
          // Frames before the clip's start can be the one shown at its start.
          from: Number.NEGATIVE_INFINITY,
          // A frame at the clip's end belongs to the next clip; one at `at` is shown at `at`.
          to: origin + (playing ? clip.end - TIMESTAMP_TOLERANCE : at + TIMESTAMP_TOLERANCE + 1),
        },
        async (frame) => {
          const time = offset + Math.max(0, onGrid(frame.timestamp - origin - clip.start));
          if (!started) {
            if (!playing && time > from) return;
            if (time <= from) {
              release(first);
              first = hold(frame, time, clip, false);
              return;
            }
            await publishFirst();
          }
          if (time > clock()) await until(time, signal);
          // More than an output frame late: a later frame may already be due.
          if (clock() - time <= frameDuration()) {
            drawNow(frame, time, clip, true, signal);
          } else {
            due(frame, time, clip, signal);
          }
        },
        signal,
      );
      if (!started) await publishFirst();
    } finally {
      release(first);
    }
  };

  /** Plays from the clock's position: each clip in turn, the next one pre-rolled before its cut. */
  const play = async (signal: AbortSignal) => {
    const end = starts[starts.length - 1] as number;
    const from = Math.max(0, Math.round(clock()));
    if (from >= end) return;
    let index = clipAt(starts, from);
    let current = runClip(index, from, true, signal);
    while (index + 1 < starts.length - 1) {
      const cut = starts[index + 1] as number;
      const preroll = new AbortController();
      const waiting = until(cut - PREROLL, AbortSignal.any([signal, preroll.signal])).catch(
        () => {},
      );
      await Promise.race([current, waiting]);
      preroll.abort();
      if (signal.aborted) break;
      index += 1;
      const next = runClip(index, cut, true, signal);
      // At most two decoders at once (docs/adr/0004): the next waits for this one.
      next.catch(() => {});
      await current;
      current = next;
    }
    await current;
  };

  const restart = (next: SchedulerCommand) => {
    controller?.abort();
    release(pending);
    pending = undefined;
    lastDrawn = Number.NEGATIVE_INFINITY;
    mode = next.mode;
    anchor = next.mode === "play" ? next.anchor : null;
    const own = new AbortController();
    controller = own;
    if (!plan || plan.clips.length === 0 || next.mode === "pause" || next.mode === "hidden") {
      return;
    }
    const work =
      next.mode === "play"
        ? play(own.signal)
        : runClip(clipAt(starts, next.at), next.at, false, own.signal);
    const settling = work.catch((reason: unknown) => {
      if (own.signal.aborted) return;
      error ??= reason;
      own.abort();
    });
    running.add(settling);
    void settling.then(() => running.delete(settling));
  };

  return {
    load(next, nextStarts) {
      plan = next;
      starts = clipStarts(next);
      sourceStarts = nextStarts;
      dropped = 0;
      restart({ mode: "pause" });
      mode = undefined;
    },
    control(command) {
      if (command.mode === "play" && mode === "play" && anchor) {
        if (sameAnchor(anchor, command.anchor)) return;
        // The audio clock drifting from wall-clock time, corrected every
        // 250 ms: follow it without restarting the decoders.
        const now = environment.now();
        const drift = Math.abs(mediaTimeAt(command.anchor, now) - mediaTimeAt(anchor, now));
        if (drift <= frameDuration()) {
          anchor = command.anchor;
          return;
        }
      }
      restart(command);
    },
    get dropped() {
      return dropped;
    },
    takeError() {
      const taken = error;
      error = undefined;
      return taken;
    },
    async settled() {
      while (running.size > 0) await Promise.all(running);
    },
    dispose() {
      restart({ mode: "pause" });
    },
  };
}
