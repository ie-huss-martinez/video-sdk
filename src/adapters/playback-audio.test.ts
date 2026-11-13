import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioLedger,
  createPlaybackAudio,
  HIDDEN_LEAD_WINDOWS,
  LEAD_WINDOWS,
  START_LEAD,
  SWITCH_LEAD,
} from "./playback-audio.js";

// The page's audio on a fake AudioContext and fake timers (docs/adr/0005,
// docs/adr/0006): what's scheduled when, how far ahead, what happens when a
// window is late, and that everything is released.

interface FakeNode {
  buffer: { length: number; channels: Float32Array[] } | null;
  startedAt?: number;
  offset?: number | undefined;
  stoppedAt?: number;
  onended: (() => void) | null;
  connect(): void;
  disconnect(): void;
  start(when: number, offset?: number): void;
  stop(when?: number): void;
}

function fakeContext(options: { blocked?: boolean; rate?: number } = {}) {
  const nodes: FakeNode[] = [];
  const context = {
    state: options.blocked ? "suspended" : "running",
    sampleRate: options.rate ?? 48_000,
    currentTime: 0,
    outputLatency: 0.02,
    baseLatency: 0.01,
    destination: {},
    closed: false,
    async resume() {
      if (!options.blocked) context.state = "running";
    },
    async close() {
      context.closed = true;
      context.state = "closed";
    },
    getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }),
    createBuffer(channels: number, length: number) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        length,
        channels: data,
        copyToChannel(source: Float32Array, index: number) {
          data[index]?.set(source);
        },
      };
    },
    createBufferSource() {
      const node: FakeNode = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        start(when, offset) {
          node.startedAt = when;
          node.offset = offset;
        },
        stop(when) {
          node.stoppedAt = when ?? context.currentTime;
        },
      };
      nodes.push(node);
      return node;
    },
  };
  return { context, nodes };
}

function setup(options: { blocked?: boolean; slow?: boolean } = {}) {
  const { context, nodes } = fakeContext(options);
  const fetches: { from: number; count: number }[] = [];
  const pending: (() => void)[] = [];
  let performanceNow = 0;
  const player = createPlaybackAudio({
    createContext: () => context as unknown as AudioContext,
    fetchWindow: (from, count) => {
      fetches.push({ from, count });
      const result = [Float32Array.from({ length: count }, (_, k) => from + k)];
      if (!options.slow) return Promise.resolve(result);
      return new Promise((resolve) => pending.push(() => resolve(result)));
    },
    timeOrigin: 1_700_000_000_000,
    performanceNow: () => performanceNow,
  });
  /** Moves the context's clock on, ending the nodes that have played out. */
  const advance = async (seconds: number) => {
    context.currentTime += seconds;
    for (const node of nodes) {
      const length = (node.buffer?.length ?? 0) / context.sampleRate;
      const ends = Math.min(
        node.stoppedAt ?? Number.POSITIVE_INFINITY,
        (node.startedAt ?? 0) + length - (node.offset ?? 0),
      );
      if (node.startedAt !== undefined && ends <= context.currentTime && node.onended) {
        const ended = node.onended;
        node.onended = null;
        ended();
      }
    }
    await vi.advanceTimersByTimeAsync(seconds * 1_000);
  };
  return {
    player,
    context,
    nodes,
    fetches,
    advance,
    setPerformanceNow(value: number) {
      performanceNow = value;
    },
    release() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  audioLedger.scheduled = 0;
  audioLedger.peak = 0;
  audioLedger.underruns = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const WINDOW = 12_000;

describe("the page's audio", () => {
  it("says when autoplay keeps the context suspended", async () => {
    const blocked = setup({ blocked: true });
    expect(await blocked.player.start()).toBe("blocked");
    const allowed = setup();
    expect(await allowed.player.start()).toBe("running");
  });

  it("starts with two windows ready, a moment ahead, and reads the clock from them", async () => {
    const t = setup();
    await t.player.start();
    t.context.currentTime = 10;
    t.context.getOutputTimestamp = () => ({ contextTime: 9.98, performanceTime: 5_000 });
    t.setPerformanceNow(5_010);
    const anchor = await t.player.play(1_000_000, 10_000_000);
    expect(t.fetches.slice(0, 2)).toEqual([
      { from: 48_000, count: WINDOW },
      { from: 60_000, count: WINDOW },
    ]);
    expect(t.nodes[0]?.startedAt).toBeCloseTo(10 + START_LEAD, 9);
    expect(t.nodes[1]?.startedAt).toBeCloseTo(10 + START_LEAD + 0.25, 9);
    // Timeline 1 s is played at context time 10.05, heard 70 ms after the
    // stamped 9.98 s was heard at performance time 5 s.
    expect(anchor?.media).toBe(1_000_000);
    expect(anchor?.at).toBeCloseTo(1_700_000_000_000 + 5_000 + 70, 6);
  });

  it("doesn't believe an output timestamp on another timeline, and reads the context's own time instead", async () => {
    const t = setup();
    await t.player.start();
    t.context.currentTime = 10;
    // WebKit on Linux: a performance time far from now.
    t.context.getOutputTimestamp = () => ({ contextTime: 9.99, performanceTime: 5_000 });
    const anchor = await t.player.play(0, 10_000_000);
    // Context time 10 is being rendered now (performance time 0), heard 20 ms later.
    expect(anchor?.at).toBeCloseTo(1_700_000_000_000 + START_LEAD * 1_000 + 20, 6);
  });

  it("doesn't believe an output timestamp in the future, as a young context's on WebKit is, so the clock doesn't jump", async () => {
    const t = setup();
    await t.player.start();
    t.context.currentTime = 0.1;
    t.setPerformanceNow(1_000);
    // WebKit on Linux, 100 ms into a context's life: the stamp is 100 ms
    // ahead of now, within the 200 ms that a stale one may be.
    t.context.getOutputTimestamp = () => ({ contextTime: 0.097, performanceTime: 1_100 });
    const first = await t.player.play(0, 10_000_000);
    // A quarter of a second later, the stamp is 350 ms ahead and refused either way.
    t.context.currentTime = 0.35;
    t.setPerformanceNow(1_250);
    t.context.getOutputTimestamp = () => ({ contextTime: 0.347, performanceTime: 1_600 });
    const second = t.player.anchor();
    // Both anchors read the context's own time, so they agree: the clock
    // doesn't jump between them.
    const mediaAt = (anchor: typeof first, wall: number) =>
      (anchor?.media ?? 0) + (wall - (anchor?.at ?? 0)) * 1_000;
    const wall = 1_700_000_000_000 + 2_000;
    expect(Math.abs(mediaAt(first, wall) - mediaAt(second, wall))).toBeLessThan(1_000);
  });

  it(`keeps ${LEAD_WINDOWS} windows ahead of the one playing, no more, and every sample once`, async () => {
    const t = setup();
    await t.player.start();
    await t.player.play(0, 10_000_000);
    for (let step = 0; step < 20; step += 1) {
      await t.advance(0.1);
      expect(audioLedger.scheduled).toBeLessThanOrEqual(LEAD_WINDOWS + 2);
    }
    const starts = t.fetches.map((fetch) => fetch.from);
    expect(starts).toEqual(starts.map((_, index) => index * WINDOW));
    expect(audioLedger.peak).toBeLessThanOrEqual(LEAD_WINDOWS + 2);
    expect(audioLedger.underruns).toBe(0);
  });

  it(`keeps ${HIDDEN_LEAD_WINDOWS} windows ahead while the page is hidden`, async () => {
    const t = setup();
    await t.player.start();
    await t.player.play(0, 60_000_000);
    t.player.setHidden(true);
    await t.advance(0.01);
    expect(t.fetches.length).toBeGreaterThanOrEqual(HIDDEN_LEAD_WINDOWS);
  });

  it("plays a late window from where the clock is, never waiting, and counts the underrun", async () => {
    const t = setup({ slow: true });
    await t.player.start();
    const playing = t.player.play(0, 10_000_000);
    t.release();
    await playing;
    // The third window arrives 0.1 s after it should have started.
    await t.advance(0.55 + START_LEAD);
    t.release();
    await vi.advanceTimersByTimeAsync(0);
    const late = t.nodes[2];
    expect(late?.startedAt).toBeCloseTo(0.55 + START_LEAD, 9);
    expect(late?.offset).toBeCloseTo(0.05, 9);
    expect(audioLedger.underruns).toBe(1);
  });

  it("switches to a new plan's windows at an exact sample a moment ahead, without a gap", async () => {
    const t = setup();
    await t.player.start();
    await t.player.play(0, 10_000_000);
    await t.advance(0.3);
    const before = t.nodes.length;
    const fetched = t.fetches.length;
    t.player.switchPlan(10_000_000);
    await vi.advanceTimersByTimeAsync(0);
    const switchTime = 0.3 + SWITCH_LEAD;
    const at = Math.ceil((switchTime - START_LEAD) * 48_000);
    const next = t.nodes[before];
    expect(t.fetches[fetched]?.from).toBe(at);
    // The new window starts exactly when the old ones stop.
    const startsAt = START_LEAD + at / 48_000;
    expect(next?.startedAt).toBeCloseTo(startsAt, 12);
    // The window playing at the switch stops on its sample; later ones never play.
    const old = t.nodes.slice(0, before);
    const playing = old.filter(
      (node) => (node.startedAt ?? 0) <= 0.3 && (node.startedAt ?? 0) + 0.25 > 0.3,
    );
    expect(playing).toHaveLength(1);
    expect(playing[0]?.stoppedAt).toBeCloseTo(startsAt, 12);
    for (const node of old.filter((entry) => (entry.startedAt ?? 0) > 0.3)) {
      expect(node.stoppedAt).toBe(0.3);
    }
  });

  it("releases every node on stop, and closes the context", async () => {
    const t = setup();
    await t.player.start();
    await t.player.play(0, 10_000_000);
    await t.advance(0.2);
    t.player.stop();
    expect(audioLedger.scheduled).toBe(0);
    await t.player.close();
    expect(t.context.closed).toBe(true);
  });

  it("stops at the plan's end", async () => {
    const t = setup();
    await t.player.start();
    await t.player.play(0, 300_000);
    await t.advance(1);
    const total = t.fetches.reduce((sum, fetch) => sum + fetch.count, 0);
    expect(total).toBe(14_400);
  });
});
