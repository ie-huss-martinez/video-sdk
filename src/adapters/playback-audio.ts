import type { PlaybackAnchor } from "../core/playback/timeline.js";

/** How long a window is: a quarter of a second (docs/adr/0005). */
export const WINDOW_SECONDS = 0.25;
/** Windows kept scheduled ahead of the one playing, while the page is visible and hidden (docs/adr/0005). */
export const LEAD_WINDOWS = 2;
export const HIDDEN_LEAD_WINDOWS = 8;
/** How far ahead playback starts once its first windows are ready, in seconds, so they're scheduled in time. */
export const START_LEAD = 0.05;
/** How far an output timestamp's performance time may be from now, in milliseconds, to be believed. */
export const PLAUSIBLE_STAMP = 200;
/** How far ahead an edit takes over from the windows already scheduled, in seconds, so the new ones are ready by then. */
export const SWITCH_LEAD = 0.2;

/**
 * Counts the audio nodes scheduled and not yet ended or stopped, and the
 * most there have been at once, for the tests that prove audio is bounded
 * and released (docs/adr/0002).
 *
 * @internal
 */
export const audioLedger = { scheduled: 0, peak: 0, underruns: 0 };

/** A window as it was scheduled, for the sync test. */
export interface ScheduledWindow {
  readonly context: AudioContext;
  /** Its first sample on the timeline, at the context's rate. */
  readonly from: number;
  /** When that sample plays, in the context's time. */
  readonly at: number;
  readonly channels: readonly Float32Array[];
}

/**
 * Called with each window scheduled, when set: the sync test reads when each
 * tone is played from it (docs/adr/0005).
 *
 * @internal
 */
export const audioTrace: { onSchedule: ((window: ScheduledWindow) => void) | null } = {
  onSchedule: null,
};

/**
 * What the player needs from the page, replaceable in tests with a fake
 * context and a fake worker.
 *
 * @internal
 */
export interface AudioEnvironment {
  /**
   * Creates the context, at the device's own rate: the worker resamples to
   * it. Some browsers open a context at another rate whose clock then barely
   * moves.
   */
  readonly createContext: () => AudioContext;
  /** One mixed window of the plan from the worker: planar channels. */
  readonly fetchWindow: (from: number, count: number, rate: number) => Promise<Float32Array[]>;
  /** `performance.timeOrigin`, to turn the context's performance times into wall-clock time. */
  readonly timeOrigin: number;
  /** `performance.now()`, when the context can't say. */
  readonly performanceNow: () => number;
}

/**
 * The page's audio for one output (docs/adr/0005, docs/adr/0006): an
 * `AudioContext` created on the first play, windows from the worker
 * scheduled ahead as `AudioBufferSourceNode`s, and the clock read from what
 * the context is heard to play.
 *
 * @internal
 */
export interface PlaybackAudio {
  /**
   * Creates or resumes the context. Resolves `"running"`, or `"blocked"`
   * when the browser's autoplay rules keep it suspended.
   */
  start(): Promise<"running" | "blocked">;
  /**
   * Plays from timeline sample `from`, stopping before `end`. Resolves the
   * clock's anchor once the first windows are ready and scheduled, or
   * `undefined` if something else stopped it first.
   */
  play(fromTime: number, endTime: number): Promise<PlaybackAnchor | undefined>;
  /** The clock now, from when the context says it's heard: sent to the worker every 250 ms. */
  anchor(): PlaybackAnchor | undefined;
  /**
   * Whether the context's clock has stopped keeping up with wall-clock time
   * over the last second or more, as when its device fails: checked every
   * 250 ms while playing.
   */
  stalled(): boolean;
  /** Takes over at a sample a little ahead with windows of the plan just loaded, without a gap. */
  switchPlan(endTime: number): void;
  /** Keeps more windows ahead while the page is hidden, whose timers are throttled. */
  setHidden(hidden: boolean): void;
  /** Stops every scheduled window at once. */
  stop(): void;
  /** Stops, and closes the context. */
  close(): Promise<void>;
}

interface Scheduled {
  readonly node: AudioBufferSourceNode;
  readonly start: number;
}

/**
 * Creates the page's audio player.
 *
 * @internal
 */
export function createPlaybackAudio(environment: AudioEnvironment): PlaybackAudio {
  let context: AudioContext | undefined;
  let hidden = false;
  /** Bumped by every stop, play and switch: windows fetched for an older one are dropped. */
  let generation = 0;
  /** The mapping from timeline samples to context time, while playing. */
  let base: { readonly sample: number; readonly time: number } | undefined;
  let next = 0;
  let end = 0;
  let fetching = false;
  /** The context's time and wall-clock time when last compared, to notice a context that stops. */
  let watch: { wall: number; time: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const scheduled = new Set<Scheduled>();

  const rate = () => (context as AudioContext).sampleRate;
  const windowLength = () => Math.round(rate() * WINDOW_SECONDS);
  const timeOf = (sample: number) =>
    (base as { time: number }).time + (sample - (base as { sample: number }).sample) / rate();
  const sampleAt = (time: number) =>
    (base as { sample: number }).sample + (time - (base as { time: number }).time) * rate();

  const release = (entry: Scheduled) => {
    if (!scheduled.delete(entry)) return;
    audioLedger.scheduled -= 1;
    entry.node.onended = null;
    entry.node.disconnect();
  };

  /** Schedules a window at its sample's time, or late, from the part still to come. */
  const schedule = (channels: Float32Array[], from: number) => {
    const audio = context as AudioContext;
    const length = channels[0]?.length ?? 0;
    if (length === 0) return;
    const buffer = audio.createBuffer(channels.length, length, rate());
    for (const [index, channel] of channels.entries()) {
      buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index);
    }
    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);
    const at = timeOf(from);
    audioTrace.onSchedule?.({ context: audio, from, at, channels });
    const late = audio.currentTime - at;
    if (late > 0) {
      // Underrun: audio never waits. Play what's left of the window, on time.
      audioLedger.underruns += 1;
      if (late >= length / rate()) return node.disconnect();
      node.start(audio.currentTime, late);
    } else {
      node.start(at);
    }
    const entry: Scheduled = { node, start: at };
    scheduled.add(entry);
    audioLedger.scheduled += 1;
    audioLedger.peak = Math.max(audioLedger.peak, audioLedger.scheduled);
    node.onended = () => {
      release(entry);
      pump();
    };
  };

  /** Fetches and schedules windows until the lead is full, one at a time. */
  const pump = () => {
    if (!context || !base || fetching) return;
    const lead = (hidden ? HIDDEN_LEAD_WINDOWS : LEAD_WINDOWS) + 1;
    const ahead = sampleAt(context.currentTime) + lead * windowLength();
    if (next >= end || next >= ahead) return;
    const from = next;
    const count = Math.min(windowLength(), end - from);
    const own = generation;
    fetching = true;
    environment.fetchWindow(from, count, rate()).then(
      (channels) => {
        fetching = false;
        if (own !== generation) return pump();
        schedule(channels, from);
        next = from + count;
        pump();
      },
      () => {
        fetching = false;
      },
    );
  };

  const stopAll = (at?: number) => {
    for (const entry of [...scheduled]) {
      if (at !== undefined && entry.start < at) {
        // Playing now: it stops at the switch, and its `ended` releases it.
        entry.node.stop(at);
        continue;
      }
      try {
        entry.node.stop();
      } catch {
        // Already stopped.
      }
      release(entry);
    }
  };

  const halt = () => {
    generation += 1;
    base = undefined;
    fetching = false;
    clearInterval(timer);
    timer = undefined;
    stopAll();
  };

  const toSample = (time: number) => Math.round((time * rate()) / 1_000_000);

  return {
    async start() {
      context ??= environment.createContext();
      if (context.state !== "running") {
        // `resume` stays pending until a gesture allows it in some browsers.
        await Promise.race([
          context.resume().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 100)),
        ]);
      }
      return context.state === "running" ? "running" : "blocked";
    },
    async play(fromTime, endTime) {
      halt();
      const audio = context as AudioContext;
      const own = generation;
      const from = toSample(fromTime);
      end = toSample(endTime);
      // The first windows, before the clock starts, so it starts with sound.
      const first = Math.min(windowLength(), end - from);
      const second = Math.min(windowLength(), end - from - first);
      const windows = await Promise.all([
        first > 0 ? environment.fetchWindow(from, first, rate()) : [],
        second > 0 ? environment.fetchWindow(from + first, second, rate()) : [],
      ]);
      if (own !== generation) return undefined;
      base = { sample: from, time: audio.currentTime + START_LEAD };
      watch = { wall: environment.performanceNow(), time: audio.currentTime };
      schedule(windows[0] as Float32Array[], from);
      if (second > 0) schedule(windows[1] as Float32Array[], from + first);
      next = from + first + second;
      timer = setInterval(pump, (WINDOW_SECONDS * 1_000) / 2);
      pump();
      return this.anchor();
    },
    anchor() {
      if (!context || !base) return undefined;
      // The output timestamp is the context time the device is playing at a
      // performance time: the output latency is already in it. Without one,
      // the context's current time is what's being rendered, which is heard
      // the output latency later.
      // WebKit on Linux gives a performance time on another timeline, which
      // runs about twice as fast: a stamp more than 200 ms from now isn't used.
      const stamp = context.getOutputTimestamp?.();
      const stamped =
        Boolean(stamp?.contextTime) &&
        stamp?.performanceTime !== undefined &&
        Math.abs(environment.performanceNow() - stamp.performanceTime) <= PLAUSIBLE_STAMP;
      const contextTime = stamped ? (stamp?.contextTime as number) : context.currentTime;
      const performanceTime = stamped
        ? (stamp?.performanceTime as number)
        : environment.performanceNow() +
          (context.outputLatency || context.baseLatency || 0) * 1_000;
      const at = environment.timeOrigin + performanceTime + (base.time - contextTime) * 1_000;
      return { media: (base.sample * 1_000_000) / rate(), at };
    },
    stalled() {
      if (!context || !base || !watch) return false;
      const wall = environment.performanceNow();
      const elapsed = (wall - watch.wall) / 1_000;
      if (elapsed < 1) return false;
      const advanced = context.currentTime - watch.time;
      watch = { wall, time: context.currentTime };
      return advanced < elapsed / 2;
    },
    switchPlan(endTime) {
      if (!context || !base) return;
      generation += 1;
      fetching = false;
      end = toSample(endTime);
      const switchAt = Math.ceil(sampleAt(context.currentTime + SWITCH_LEAD));
      // Windows that start after the switch go; the one playing stops at it.
      stopAll(timeOf(switchAt));
      next = switchAt;
      pump();
    },
    setHidden(value) {
      hidden = value;
      pump();
    },
    stop() {
      halt();
    },
    async close() {
      halt();
      const audio = context;
      context = undefined;
      await audio?.close().catch(() => {});
    },
  };
}
