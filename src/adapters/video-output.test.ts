import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoError } from "../core/errors/video-error.js";
import { videoLimits } from "../core/errors/video-limits.js";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoPlan,
} from "../core/model/plan.js";
import type { VideoProbe } from "../core/model/source.js";
import type { SchedulerCommand } from "../core/playback/scheduler.js";
import type { PlaybackSource } from "./media-worker/contract.js";
import { createOutput } from "./video-output.js";

// The page's side of playback on a fake clock (docs/adr/0006): what it tells
// the worker, when it ends, how it steps, and what it does while the page is
// hidden. The worker is a fake that records the calls.

const RATE = { num: 30, den: 1 };

function clip(frames: number): VideoClip {
  return {
    key: `k${frames}`,
    source: "s",
    start: 0,
    end: clipEnd(0, frames, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

function planOf(frames: number): VideoPlan {
  return {
    ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
    clips: [clip(frames)],
  };
}

const SOURCE: PlaybackSource = {
  id: "s",
  file: new Blob([]),
  probe: { start: 0 } as VideoProbe,
  limits: {} as PlaybackSource["limits"],
};

/** A source with audio, for the audio clock. */
const WITH_AUDIO: PlaybackSource = {
  ...SOURCE,
  probe: { start: 0, audio: { codec: "opus", sampleRate: 48_000, channels: 2 } } as VideoProbe,
};

function fakeAudioContext(blocked: boolean) {
  const context = {
    state: blocked ? "suspended" : "running",
    sampleRate: 48_000,
    currentTime: 0,
    outputLatency: 0,
    baseLatency: 0,
    destination: {},
    close: vi.fn(async () => {}),
    resume: async () => {},
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    createBuffer: (channels: number, length: number) => ({
      copyToChannel() {},
      length,
      numberOfChannels: channels,
    }),
    createBufferSource: () => ({
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }),
  };
  return context;
}

function setup(options: { audio?: ReturnType<typeof fakeAudioContext> } = {}) {
  const commands: SchedulerCommand[] = [];
  const resizes: { width: number; height: number }[] = [];
  let hidden = false;
  let onVisibility = () => {};
  let failControl: VideoError | undefined;
  const destroyed = vi.fn();
  const output = createOutput({
    connect: () => ({
      call: async (method, input) => {
        if (method === "resize") resizes.push(input as { width: number; height: number });
        if (method === "audio") {
          const { count } = input as { count: number };
          return { channels: [new Float32Array(count), new Float32Array(count)] } as never;
        }
        if (method === "control") {
          commands.push(input as SchedulerCommand);
          if (failControl) {
            const failure = failControl;
            failControl = undefined;
            throw failure;
          }
          return { droppedFrames: 3 } as never;
        }
        return undefined as never;
      },
      destroy: destroyed,
    }),
    source: (id) => (id === "s" ? (options.audio ? WITH_AUDIO : SOURCE) : undefined),
    ...(options.audio
      ? {
          audio: {
            createContext: () => options.audio as unknown as AudioContext,
            timeOrigin: 0,
            performanceNow: () => Date.now(),
          },
        }
      : {}),
    now: () => Date.now(),
    policy: videoLimits.resolve(),
    visibility: {
      hidden: () => hidden,
      subscribe(listener) {
        onVisibility = listener;
        return () => {};
      },
    },
  });
  return {
    output,
    commands,
    resizes,
    destroyed,
    last: () => commands.at(-1),
    setHidden(value: boolean) {
      hidden = value;
      onVisibility();
    },
    failNextControl(error: VideoError) {
      failControl = error;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the video output's page side", () => {
  it("plays from an anchor at the playhead, and reads the playhead from it", async () => {
    const t = setup();
    t.output.load(planOf(90));
    t.output.seek(30);
    expect(t.last()).toEqual({ mode: "show", at: 1_000_000 });
    await t.output.play();
    expect(t.last()).toEqual({ mode: "play", anchor: { media: 1_000_000, at: Date.now() } });
    await vi.advanceTimersByTimeAsync(500);
    expect(t.output.position()).toBe(45);
    expect(t.output.getSnapshot()).toMatchObject({ state: "playing", droppedFrames: 3 });
  });

  it("sends the same anchor every 250 ms while playing, so the worker can report back", async () => {
    const t = setup();
    t.output.load(planOf(90));
    await t.output.play();
    const sent = t.commands.length;
    await vi.advanceTimersByTimeAsync(1_000);
    const sinceThen = t.commands.slice(sent);
    expect(sinceThen).toHaveLength(4);
    expect(new Set(sinceThen.map((command) => JSON.stringify(command))).size).toBe(1);
  });

  it("stops at the end with the last frame shown, and fires ended once", async () => {
    const t = setup();
    t.output.load(planOf(30));
    const ended = vi.fn();
    t.output.on("ended", ended);
    await t.output.play();
    await vi.advanceTimersByTimeAsync(999);
    expect(ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(t.output.getSnapshot().state).toBe("stopped");
    expect(t.output.position()).toBe(30);
    expect(t.last()).toEqual({ mode: "pause" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("doesn't fire ended on a seek or a step to the end", async () => {
    const t = setup();
    t.output.load(planOf(30));
    const ended = vi.fn();
    t.output.on("ended", ended);
    t.output.seek(30);
    // At the end, the last frame is shown.
    expect(t.last()).toEqual({ mode: "show", at: 966_667 });
    t.output.seek(28);
    t.output.step(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended).not.toHaveBeenCalled();
  });

  it("steps exactly one frame, pausing, as a seek the worker draws", async () => {
    const t = setup();
    t.output.load(planOf(90));
    await t.output.play();
    await vi.advanceTimersByTimeAsync(400);
    t.output.step(1);
    expect(t.output.getSnapshot().state).toBe("paused");
    expect(t.output.position()).toBe(13);
    expect(t.last()).toEqual({ mode: "show", at: 433_333 });
    t.output.step(-1);
    expect(t.output.position()).toBe(12);
    t.output.seek(0);
    const sent = t.commands.length;
    t.output.step(-1);
    expect(t.commands).toHaveLength(sent);
  });

  it("stops the worker's decoding while the page is hidden, keeps the clock, and resyncs when it's visible", async () => {
    const t = setup();
    t.output.load(planOf(300));
    await t.output.play();
    await vi.advanceTimersByTimeAsync(1_000);
    t.setHidden(true);
    expect(t.last()).toEqual({ mode: "hidden" });
    const sent = t.commands.length;
    await vi.advanceTimersByTimeAsync(2_000);
    // Nothing is sent while hidden, but the clock runs on.
    expect(t.commands).toHaveLength(sent);
    expect(t.output.position()).toBe(90);
    t.setHidden(false);
    // Visible again: the same anchor, which the worker plays from the clock's position.
    expect(t.last()).toEqual({
      mode: "play",
      anchor: { media: 0, at: 1_700_000_000_000 },
    });
  });

  it("ends at once when the page is visible again after the clock passed the end while hidden", async () => {
    const t = setup();
    t.output.load(planOf(30));
    const ended = vi.fn();
    t.output.on("ended", ended);
    await t.output.play();
    t.setHidden(true);
    // A hidden tab's timers run late: move the clock past the end without firing them.
    vi.setSystemTime(Date.now() + 5_000);
    expect(ended).not.toHaveBeenCalled();
    t.setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(t.output.getSnapshot().state).toBe("stopped");
    expect(t.output.position()).toBe(30);
    expect(t.last()).toEqual({ mode: "pause" });
  });

  it("resizes the canvas to the stage times a capped pixel ratio, redrawing the frame when paused", async () => {
    const t = setup();
    t.output.load(planOf(90));
    t.output.seek(10);
    const sent = t.commands.length;
    t.output.resize(320, 180, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.resizes).toEqual([{ width: 640, height: 360 }]);
    expect(t.commands.slice(sent)).toEqual([{ mode: "show", at: 333_333 }]);
    // A ratio over 4 is drawn at 4.
    t.output.resize(100, 50, 10);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.resizes.at(-1)).toEqual({ width: 400, height: 200 });
    // Playing, the next frame redraws: no seek is sent.
    await t.output.play();
    const playing = t.commands.length;
    t.output.resize(320, 180, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.commands).toHaveLength(playing);
  });

  it("refuses a backing size over maxFramePixels before telling the worker", async () => {
    const t = setup();
    t.output.load(planOf(90));
    expect(() => t.output.resize(4_000, 3_000, 1)).toThrow(
      expect.objectContaining({ code: "FRAME_TOO_LARGE" }),
    );
    expect(() => t.output.resize(-1, 3)).toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.resizes).toEqual([]);
  });

  it("keeps the clock when the plan changes while playing, and stops at a shorter plan's end", async () => {
    const t = setup();
    t.output.load(planOf(90));
    await t.output.play();
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(1_000);
    t.output.load(planOf(60));
    expect(t.last()).toEqual({ mode: "play", anchor: { media: 0, at: started } });
    expect(t.output.position()).toBe(30);
    t.output.load(planOf(20));
    expect(t.output.getSnapshot().state).toBe("stopped");
    expect(t.output.position()).toBe(20);
  });

  it("pauses with the error when the worker reports a failure, and clears it on play", async () => {
    const t = setup();
    t.output.load(planOf(90));
    await t.output.play();
    t.failNextControl(
      new VideoError("DECODE_FAILED", "The browser couldn't decode the video track."),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(t.output.getSnapshot()).toMatchObject({
      state: "paused",
      error: { code: "DECODE_FAILED" },
    });
    expect(t.output.position()).toBe(7);
    await t.output.play();
    expect(t.output.getSnapshot()).toMatchObject({ state: "playing", error: null });
  });

  it("plays silently on the performance clock when autoplay blocks audio, and says so", async () => {
    const context = fakeAudioContext(true);
    const t = setup({ audio: context });
    t.output.load(planOf(90));
    await t.output.play();
    expect(t.output.getSnapshot()).toMatchObject({ state: "playing", audio: "blocked" });
    await vi.advanceTimersByTimeAsync(500);
    expect(t.output.position()).toBe(15);
    await t.output.destroy();
    expect(context.close).toHaveBeenCalled();
  });

  it("takes the clock from the audio when it plays", async () => {
    const context = fakeAudioContext(false);
    const t = setup({ audio: context });
    t.output.load(planOf(90));
    await t.output.play();
    expect(t.output.getSnapshot()).toMatchObject({ state: "playing", audio: "ready" });
    // Timeline 0 is played 50 ms after the context's time 0, which is heard at wall time 0 + now.
    const sent = t.last();
    expect(sent).toMatchObject({ mode: "play", anchor: { media: 0 } });
    if (sent?.mode !== "play") throw new Error("expected play");
    expect(sent.anchor.at).toBeCloseTo(Date.now() + 50, 0);
    await t.output.destroy();
    expect(context.close).toHaveBeenCalled();
  });

  it("goes on silently from where the clock is when the audio stops keeping time", async () => {
    // A context that says it's running, but whose time never moves.
    const context = fakeAudioContext(false);
    const t = setup({ audio: context });
    t.output.load(planOf(300));
    await t.output.play();
    expect(t.output.getSnapshot().audio).toBe("ready");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.output.getSnapshot()).toMatchObject({ state: "playing", audio: "blocked" });
    const then = t.output.position();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.output.position()).toBe(then + 30);
    await t.output.destroy();
  });

  it("refuses a plan whose sources aren't open, and calls after destroy", async () => {
    const t = setup();
    expect(() => t.output.load({ ...planOf(30), clips: [{ ...clip(30), source: "x" }] })).toThrow(
      TypeError,
    );
    t.output.load(planOf(30));
    await t.output.destroy();
    expect(t.destroyed).toHaveBeenCalled();
    expect(() => t.output.seek(3)).toThrow();
    await expect(t.output.play()).rejects.toThrow();
  });
});
