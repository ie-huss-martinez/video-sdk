import { afterEach, describe, expect, it } from "vitest";
import { clipEnd, createPlan, IDENTITY_TRANSFORM, NO_FADE, type VideoClip } from "../model/plan.js";
import {
  createFrameScheduler,
  type SchedulerCommand,
  type SchedulerRange,
  schedulerLedger,
  TIMESTAMP_TOLERANCE,
} from "./scheduler.js";

// The scheduler's decisions on a fake clock (docs/adr/0006): a manual
// wall clock and animation frames at 60 a second, a fake decoder over
// sources at 30 frames a second with a key frame every 30, and a surface
// that records what was drawn and when.

const RATE = { num: 30, den: 1 };
const FRAME = 1_000_000 / 30;
const REFRESH = 1_000 / 60;

interface FakeFrame {
  readonly timestamp: number;
  clone(): FakeFrame;
  close(): void;
}

function clip(key: string, source: string, startFrame: number, frames: number): VideoClip {
  const start = Math.round(startFrame * FRAME);
  return {
    key,
    source,
    start,
    end: clipEnd(start, frames, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

function planOf(...clips: VideoClip[]) {
  return {
    ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
    clips,
  };
}

function setup(options: { origin?: number; frames?: number; milliseconds?: boolean } = {}) {
  const origin = options.origin ?? 0;
  // WebM's timestamps: whole milliseconds.
  const stamp = (index: number) =>
    options.milliseconds ? Math.round(index * (FRAME / 1_000)) * 1_000 : Math.round(index * FRAME);
  const total = options.frames ?? 300;
  let now = 1_700_000_000_000;
  let waiters: (() => void)[] = [];
  let open = 0;
  let decoding = 0;
  let peakDecoding = 0;
  const decodes: { source: string; range: SchedulerRange; at: number }[] = [];
  const drawn: { source: string; frame: number; clip: string; at: number }[] = [];
  let failNext: Error | undefined;
  let mediaNow = () => 0;

  const make = (timestamp: number): FakeFrame => {
    open += 1;
    let closed = false;
    return {
      timestamp,
      clone: () => make(timestamp),
      close() {
        if (closed) throw new Error("closed twice");
        closed = true;
        open -= 1;
      },
    };
  };

  const scheduler = createFrameScheduler<FakeFrame>({
    now: () => now,
    animationFrame: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      }),
    async decode(source, range, onFrame, signal) {
      if (failNext) {
        const failure = failNext;
        failNext = undefined;
        throw failure;
      }
      decodes.push({ source, range, at: mediaNow() });
      decoding += 1;
      peakDecoding = Math.max(peakDecoding, decoding);
      try {
        const key = Math.floor(Math.floor((range.keyFrom - origin) / FRAME + 1e-6) / 30) * 30;
        for (let index = Math.max(0, key); index < total; index += 1) {
          signal.throwIfAborted();
          const timestamp = origin + stamp(index);
          if (timestamp >= range.to) break;
          const frame = make(timestamp);
          try {
            if (timestamp >= range.from) await onFrame(frame);
          } finally {
            frame.close();
          }
        }
      } finally {
        decoding -= 1;
      }
    },
    draw(frame, drawnClip) {
      drawn.push({
        source: drawnClip.source,
        frame: Math.round((frame.timestamp - origin) / FRAME),
        clip: drawnClip.key,
        at: mediaNow(),
      });
    },
  });

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  let anchor = { media: 0, at: now };
  mediaNow = () => anchor.media + (now - anchor.at) * 1_000;

  return {
    scheduler,
    drawn,
    decodes,
    get open() {
      return open;
    },
    get peakDecoding() {
      return peakDecoding;
    },
    failNext(error: Error) {
      failNext = error;
    },
    /** The clock now, in timeline microseconds. */
    media: () => mediaNow(),
    /** Plays from a timeline time, in microseconds. */
    play(media: number) {
      anchor = { media, at: now };
      scheduler.control({ mode: "play", anchor });
    },
    control(command: SchedulerCommand) {
      scheduler.control(command);
    },
    /** Lets wall-clock time pass, one animation frame at a time, or all at once in one. */
    async advance(milliseconds: number, step = REFRESH) {
      await flush();
      for (let passed = 0; passed < milliseconds - 1e-9; passed += step) {
        now += Math.min(step, milliseconds - passed);
        const due = waiters;
        waiters = [];
        for (const wake of due) wake();
        await flush();
        await flush();
      }
    },
    flush,
  };
}

afterEach(() => {
  expect(schedulerLedger.held, "clones left open").toBe(0);
});

describe("the frame scheduler", () => {
  it("draws each frame when the clock reaches its time, in order, never early", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 90)), new Map([["s", 0]]));
    t.play(0);
    await t.advance(1_000);
    const frames = t.drawn.map((entry) => entry.frame);
    expect(frames.slice(0, 30)).toEqual([...Array(30).keys()]);
    for (const entry of t.drawn) {
      const time = entry.frame * FRAME;
      expect(entry.at).toBeGreaterThanOrEqual(time - 1);
      // Within one animation frame of its time.
      expect(entry.at - time).toBeLessThan(REFRESH * 1_000 + 1);
    }
    expect(t.scheduler.dropped).toBe(0);
    t.scheduler.dispose();
    await t.scheduler.settled();
    expect(t.open).toBe(0);
  });

  it("waits inside the decoder's consumer, so decoding never runs ahead of the clock", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    t.play(0);
    await t.advance(500);
    // The fake decoder lends one frame at a time: it can't have gone past the next one.
    expect(t.open).toBeLessThanOrEqual(3);
    expect(t.drawn.length).toBeGreaterThanOrEqual(15);
    t.scheduler.dispose();
    await t.scheduler.settled();
    expect(t.open).toBe(0);
  });

  it("draws the latest due frame and counts the ones skipped when the clock jumps", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    t.play(0);
    await t.advance(REFRESH);
    const before = t.drawn.length;
    // Half a second passes in one animation frame, as when decoding stalls.
    await t.advance(500, 500);
    await t.advance(REFRESH * 2);
    const after = t.drawn.slice(before).map((entry) => entry.frame);
    expect(after[0]).toBeGreaterThanOrEqual(14);
    expect(t.scheduler.dropped).toBeGreaterThanOrEqual(10);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    t.scheduler.dispose();
    await t.scheduler.settled();
  });

  it("shows the latest frame at or before a time, decoding from the key frame before it", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    t.control({ mode: "show", at: Math.round(45.5 * FRAME) });
    await t.scheduler.settled();
    expect(t.drawn.map((entry) => entry.frame)).toEqual([45]);
    expect(t.decodes[0]?.range.keyFrom).toBe(Math.round(45.5 * FRAME) + TIMESTAMP_TOLERANCE);
    expect(t.open).toBe(0);
  });

  it("lands exactly on frames whose timestamps are rounded to milliseconds", async () => {
    const t = setup({ milliseconds: true });
    const plan = planOf(clip("a", "s", 30, 90));
    t.scheduler.load(plan, new Map([["s", 0]]));
    for (const frame of [0, 1, 50, 59, 89]) {
      t.control({ mode: "show", at: Math.round(frame * FRAME) });
      await t.scheduler.settled();
    }
    expect(t.drawn.map((entry) => entry.frame)).toEqual([30, 31, 80, 89, 119]);
  });

  it("coalesces seeks: only the latest is drawn", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    for (const frame of [10, 70, 130, 200]) {
      t.control({ mode: "show", at: Math.round(frame * FRAME) });
    }
    await t.scheduler.settled();
    await t.flush();
    expect(t.drawn.map((entry) => entry.frame)).toEqual([200]);
    expect(t.open).toBe(0);
  });

  it("counts timestamps from the source's start", async () => {
    const t = setup({ origin: 1_000_000 });
    t.scheduler.load(planOf(clip("a", "s", 0, 90)), new Map([["s", 1_000_000]]));
    t.control({ mode: "show", at: Math.round(12 * FRAME) });
    await t.scheduler.settled();
    expect(t.drawn.map((entry) => entry.frame)).toEqual([12]);
  });

  it("pre-rolls the next clip one second before the cut, draws its first frame at the cut, and runs at most two decoders", async () => {
    const t = setup();
    // 2 s of frames 100–159, then 1 s of frames 0–29.
    t.scheduler.load(
      planOf(clip("a", "s", 100, 60), clip("b", "s", 0, 30), clip("c", "s", 200, 30)),
      new Map([["s", 0]]),
    );
    t.play(0);
    await t.advance(3_500);
    const second = t.decodes[1];
    expect(second?.range.keyFrom).toBe(TIMESTAMP_TOLERANCE);
    // Within an animation frame of one second before the cut at 2 s.
    expect(second?.at).toBeGreaterThanOrEqual(1_000_000 - 1);
    expect(second?.at).toBeLessThan(1_000_000 + REFRESH * 1_000 + 1);
    expect(t.peakDecoding).toBeLessThanOrEqual(2);
    const frames = t.drawn.map((entry) => `${entry.clip}${entry.frame}`);
    const cut = frames.indexOf("b0");
    expect(frames[cut - 1]).toBe("a159");
    expect(t.drawn[cut]?.at).toBeGreaterThanOrEqual(2_000_000 - 1);
    expect(frames).toContain("c200");
    expect(frames.indexOf("c200")).toBe(frames.indexOf("b29") + 1);
    expect(t.scheduler.dropped).toBe(0);
    t.scheduler.dispose();
    await t.scheduler.settled();
    expect(t.open).toBe(0);
  });

  it("stops decoding while paused, and draws nothing", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    t.play(0);
    await t.advance(300);
    t.control({ mode: "pause" });
    await t.scheduler.settled();
    const count = t.drawn.length;
    await t.advance(300);
    expect(t.drawn).toHaveLength(count);
    expect(t.open).toBe(0);
  });

  it("decodes nothing while the page is hidden, and resyncs to the clock like a seek when it's visible", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    t.play(0);
    await t.advance(300);
    t.control({ mode: "hidden" });
    await t.scheduler.settled();
    const decodes = t.decodes.length;
    const drawn = t.drawn.length;
    // The clock runs on while hidden: audio keeps it.
    await t.advance(2_000, 250);
    expect(t.decodes).toHaveLength(decodes);
    expect(t.drawn).toHaveLength(drawn);
    expect(t.open).toBe(0);
    // Visible again: play from where the clock is, 2.3 s in.
    t.play(t.media());
    await t.advance(REFRESH * 2);
    const resync = t.decodes[decodes];
    expect(resync?.range.keyFrom).toBe(2_300_001 + TIMESTAMP_TOLERANCE);
    expect(t.drawn[drawn]?.frame).toBe(69);
    t.scheduler.dispose();
    await t.scheduler.settled();
  });

  it("ignores a play with the anchor already playing, and restarts on a new plan", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    const anchor = { media: 0, at: 1_700_000_000_000 };
    t.control({ mode: "play", anchor });
    await t.advance(100);
    t.control({ mode: "play", anchor });
    expect(t.decodes).toHaveLength(1);
    t.scheduler.load(planOf(clip("a", "s", 100, 200)), new Map([["s", 0]]));
    t.control({ mode: "play", anchor });
    await t.advance(REFRESH * 2);
    expect(t.decodes).toHaveLength(2);
    expect(t.drawn.at(-1)?.frame).toBeGreaterThanOrEqual(100);
    t.scheduler.dispose();
    await t.scheduler.settled();
  });

  it("reports a decoding failure once, and stops", async () => {
    const t = setup();
    t.scheduler.load(planOf(clip("a", "s", 0, 300)), new Map([["s", 0]]));
    const failure = new Error("decoding failed");
    t.failNext(failure);
    t.play(0);
    await t.scheduler.settled();
    expect(t.scheduler.takeError()).toBe(failure);
    expect(t.scheduler.takeError()).toBeUndefined();
    expect(t.open).toBe(0);
  });
});
