import { audioOutput } from "@hussmartinez/sdk-config/testing/audio-output";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { audioLedger, audioTrace, type ScheduledWindow } from "../src/adapters/playback-audio.js";
import { createEngine } from "../src/adapters/video-engine.js";
import { createVideoOutput } from "../src/adapters/video-output.js";
import {
  clipOffsets,
  locateFrame,
  type VideoEngine,
  type VideoOutput,
  type VideoPlan,
} from "../src/index.js";
import { clipOf, planOf as hdPlanOf } from "./contracts/helpers.js";
import {
  describeVideoOutputContract,
  type VideoOutputHarness,
} from "./contracts/video-output.contract.js";
import landscapeVp8 from "./fixtures/video/landscape-vp8.webm?url";
import numberedBeeps from "./fixtures/video/numbered-beeps.webm?url";
import numberedVp8 from "./fixtures/video/numbered-vp8.webm?url";
import { DEV_WORKER_START_TIMEOUT } from "./support/load.js";
import type {
  DrawnRecord,
  LagRecord,
  LedgerRecord,
  TestPortMessage,
} from "./workers/playback.worker.js";

// Real decoding, playback and export run in workers, and a heavily loaded
// machine slows them several times over: a minute per test, so that load
// fails a test only through its own checks. Waits inside get their own
// timeouts, so no step runs on a nearly spent budget.
vi.setConfig({ testTimeout: 60_000 });

// Playback over the real engine and output (docs/adr/0006), in every browser
// engine: the numbered fixture shows each frame's number, and the worker
// reads back what it drew.

const FRAME = 1_000_000 / 30;

/** A plan at the fixture's size, 256 × 32, so pixels map one to one. */
function planOf(...clips: Parameters<typeof hdPlanOf>): VideoPlan {
  const plan = hdPlanOf(...clips);
  return { ...plan, output: { ...plan.output, width: 256, height: 32 } };
}

/** The output frame at a clock time, without floating-point error at frame starts. */
const frameOf = (time: number) => Math.floor((time * 30) / 1_000_000 + 1e-9);

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

let drawn: DrawnRecord[] = [];
let ledgers: LedgerRecord[] = [];
let lags: LagRecord[] = [];
/** The ports to the workers the current test started. */
const ports: MessagePort[] = [];

/** Starts a playback test worker, with a port for its reports. */
function startWorker(): Worker {
  const worker = new Worker(new URL("./workers/playback.worker.ts", import.meta.url), {
    type: "module",
  });
  const channel = new MessageChannel();
  channel.port1.addEventListener(
    "message",
    (event: MessageEvent<DrawnRecord | LedgerRecord | LagRecord>) => {
      if (event.data.type === "drawn") drawn.push(event.data);
      else if (event.data.type === "lag") lags.push(event.data);
      else ledgers.push(event.data);
    },
  );
  channel.port1.start();
  ports.push(channel.port1);
  worker.postMessage(
    { type: "video-sdk-test-port", port: channel.port2 } satisfies TestPortMessage,
    [channel.port2],
  );
  return worker;
}

const engines: VideoEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.destroy();
});

async function setup(url: string = numberedVp8) {
  for (const port of ports.splice(0)) port.close();
  const engine = createEngine({
    loadWorker: async () => startWorker,
    startTimeout: DEV_WORKER_START_TIMEOUT,
  });
  const file = await (await fetch(url)).blob();
  engines.push(engine);
  const source = await engine.open("numbered", file, await engine.probe(file));
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 32;
  document.body.append(canvas);
  const output = createVideoOutput({ engine, canvas });
  drawn = [];
  return { engine, source, output };
}

/** The source frame the plan shows at an output frame. */
function planned(plan: VideoPlan, frame: number): { clip: string; number: number } | undefined {
  const located = locateFrame(plan, frame);
  if (!located) return undefined;
  const clip = plan.clips[located.index];
  return clip && { clip: clip.key, number: Math.round(located.sourceTime / FRAME) };
}

/**
 * Waits for the next frame drawn while paused, and returns its number. Frames
 * drawn before it's called are dropped: starting playback draws its start
 * frame paused too.
 */
async function shown(): Promise<number> {
  drawn = drawn.filter((record) => record.clock !== null);
  await vi.waitFor(() => expect(drawn.some((record) => record.clock === null)).toBe(true), {
    timeout: 15_000,
  });
  const record = drawn.find((entry) => entry.clock === null) as DrawnRecord;
  drawn = [];
  return record.number;
}

/** Waits until the playback worker holds no frame. */
async function noFramesOpen(): Promise<void> {
  await vi.waitFor(
    async () => {
      ledgers = [];
      for (const port of ports) port.postMessage({ type: "ledger" });
      await sleep(20);
      expect(ledgers).toHaveLength(ports.length);
      for (const ledger of ledgers) expect(ledger).toMatchObject({ open: 0, held: 0, audio: 0 });
    },
    { timeout: 15_000, interval: 50 },
  );
}

const harness: VideoOutputHarness = {
  async create() {
    const { output, source } = await setup();
    return {
      output,
      source,
      // The time that actually passed: a busy browser's timers run late.
      async elapse(frames) {
        const start = performance.now();
        await sleep((frames * 1_000) / 30);
        return Math.round(((performance.now() - start) * 30) / 1_000);
      },
    };
  },
  // The clock's own scheduling: a frame or two, plus the moment between
  // reading the time and the position.
  positionTolerance: 4,
};

describeVideoOutputContract("the SDK's output", harness);

describe("drawing what the plan places at the clock", () => {
  let output: VideoOutput | undefined;
  afterEach(async () => {
    await output?.destroy();
    output = undefined;
  });

  it("draws each frame of a plan with a cut when the clock reaches it, or counts it dropped", async () => {
    const real = await setup();
    output = real.output;
    // Source frames 30–89, then 0–29: three seconds with a cut at 2 s.
    const plan = planOf(
      clipOf("a", real.source, Math.round(30 * FRAME), 60),
      clipOf("b", real.source, 0, 30),
    );
    output.load(plan);
    await shown();
    await output.play();
    await vi.waitFor(() => expect(output?.getSnapshot().state).toBe("stopped"), {
      timeout: 10_000,
    });
    const playing = drawn.filter((record) => record.clock !== null);
    const late: number[] = [];
    for (const record of playing) {
      // The pixels are the frame the worker meant to draw.
      expect(record.number).toBe(Math.round(record.sourceTime / FRAME));
      // It's the frame the plan places at the clock, or one shortly before it: never a later one.
      const at = Math.min(frameOf(record.clock as number), 89);
      const behind = BEHIND.find((d) => {
        const expected = planned(plan, at - d);
        return expected?.clip === record.clip && expected.number === record.number;
      });
      expect(behind, `frame ${record.number} of ${record.clip} at ${at}`).toBeDefined();
      late.push(behind as number);
    }
    // Drawn in the plan's order, across the cut.
    const order = playing.map((record) => `${record.clip}${record.number}`);
    expect(order.indexOf("b0")).toBeGreaterThan(order.indexOf("a89"));
    // Every frame was drawn or counted dropped.
    const distinct = new Set(order).size;
    expect(distinct + (output.getSnapshot().droppedFrames ?? 0)).toBeGreaterThanOrEqual(88);
    expect(late.filter((d) => d === 0).length / late.length).toBeGreaterThan(0.7);
    await noFramesOpen();
  });

  it("draws the first frame of a source whose audio starts before it, as Opus's does", async () => {
    const real = await setup(landscapeVp8);
    output = real.output;
    output.load({
      ...planOf(clipOf("a", real.source, 0, 30)),
      output: { ...planOf().output, width: 1280, height: 720 },
    });
    // A frame is drawn at the start, paused.
    await shown();
    await noFramesOpen();
  });

  it("seeks and steps to exact frames, across a cut", async () => {
    const real = await setup();
    output = real.output;
    const plan = planOf(
      clipOf("a", real.source, Math.round(30 * FRAME), 60),
      clipOf("b", real.source, 0, 30),
    );
    output.load(plan);
    expect(await shown()).toBe(30);
    output.seek(50);
    expect(await shown()).toBe(80);
    output.seek(59);
    expect(await shown()).toBe(89);
    output.step(1);
    expect(await shown()).toBe(0);
    output.step(1);
    expect(await shown()).toBe(1);
    output.step(-1);
    output.step(-1);
    // Coalesced: only the latest step is drawn.
    expect(await shown()).toBe(89);
    output.seek(90);
    // The end shows the last frame.
    expect(await shown()).toBe(29);
    await noFramesOpen();
  });

  it("resizes the canvas, keeping exact frames, and letterboxes another shape", async () => {
    const real = await setup();
    output = real.output;
    output.load(planOf(clipOf("a", real.source, 0, 120)));
    expect(await shown()).toBe(0);
    output.seek(40);
    expect(await shown()).toBe(40);
    // 128 × 16 CSS pixels at a ratio of 4.
    output.resize(128, 16, 4);
    await vi.waitFor(() => expect(drawn.some((record) => record.clock === null)).toBe(true));
    expect(drawn[0]).toMatchObject({ number: 40, width: 512, height: 64 });
    drawn = [];
    // Taller than the output: letterboxed above and below.
    output.resize(256, 128);
    output.step(1);
    await vi.waitFor(() => expect(drawn.some((record) => record.number === 41)).toBe(true));
    expect(drawn.at(-1)).toMatchObject({ number: 41, width: 256, height: 128 });
    await noFramesOpen();
  });

  it("draws the new plan's frames after an edit during playback, and holds no frame after each step", async () => {
    const real = await setup();
    output = real.output;
    output.load(planOf(clipOf("a", real.source, 0, 120)));
    await shown();
    await output.play();
    await sleep(500);
    const edited = planOf(
      clipOf("x", real.source, Math.round(60 * FRAME), 60),
      clipOf("y", real.source, 0, 60),
    );
    output.load(edited);
    await sleep(500);
    const after = drawn.filter((record) => record.clip === "x" || record.clip === "y");
    expect(after.length).toBeGreaterThan(5);
    for (const record of after) {
      const at = frameOf(record.clock as number);
      const matches = BEHIND.some((d) => {
        const expected = planned(edited, at - d);
        return expected?.clip === record.clip && expected.number === record.number;
      });
      expect(matches, `frame ${record.number} of ${record.clip} at ${at}`).toBe(true);
    }
    expect(clipOffsets(edited)).toEqual([0, 60]);
    output.pause();
    await noFramesOpen();
    output.seek(70);
    expect(await shown()).toBe(10);
    await noFramesOpen();
    await output.play();
    await sleep(200);
    output.stop();
    expect(await shown()).toBe(60);
    await noFramesOpen();
  });
});

/** Calls `play` from a real click, as browsers' autoplay rules require for sound. */
async function playFromGesture(target: VideoOutput): Promise<void> {
  const button = document.createElement("button");
  button.textContent = "Play";
  let playing: Promise<void> | undefined;
  button.addEventListener("click", () => {
    playing = target.play();
  });
  document.body.append(button);
  await userEvent.click(button);
  button.remove();
  await playing;
}

/**
 * Skips a test that needs audio where this browser can't play it at
 * real-time speed, probed once per run by the family's shared helper
 * (sdk-core ADR 0043): Firefox in the CI image has no audio output. It's
 * called inside the tests, not when the file loads, because its click gives
 * the page user activation, after which the autoplay test can't see audio
 * blocked.
 */
async function needAudio(context: TestContext): Promise<void> {
  const audio = await audioOutput({ activate: (button) => userEvent.click(button) });
  if (!audio.available) context.skip(`no real-time audio output${audio.reason}`);
}

/**
 * Milliseconds allowed on top of the one-frame tolerance for the test
 * runner's own timing (docs/adr/0006): the flash's draw time and the
 * tone's output timestamp are read by a busy browser in CI, a few hundred
 * microseconds apart at best. Not part of the design tolerance.
 */
const RUNNER_JITTER = 2;

/**
 * How many frames behind the clock a drawn frame may be, under a heavily
 * loaded machine: the draw itself, and the record of it, run late there.
 * A frame is never later than the plan places it at the clock; how far
 * behind it may be is the runner's, not the scheduler's. The share of
 * frames drawn exactly on time is checked separately.
 */
const LOAD_LAG = 8;
/**
 * Measures how late the page's timers run while `during` runs: a loaded
 * runner's own noise, which the sync check allows on top of its one output
 * frame. Returns the 90th percentile of the lateness, in milliseconds: near
 * 0 on a quiet runner, so the check stays as tight as it was there.
 */
async function runnerLag(during: () => Promise<void>): Promise<number> {
  const late: number[] = [];
  let expected = performance.now() + 10;
  const timer = setInterval(() => {
    const now = performance.now();
    late.push(Math.max(0, now - expected));
    expected = now + 10;
  }, 10);
  try {
    await during();
  } finally {
    clearInterval(timer);
  }
  late.sort((a, b) => a - b);
  return late[Math.floor(late.length * 0.9)] ?? 0;
}

/** Each playback worker's timer lateness since a wall time: its p90, in milliseconds. */
async function workerLags(since: number): Promise<number[]> {
  lags = [];
  for (const port of ports) port.postMessage({ type: "lag", since });
  await vi.waitFor(() => expect(lags).toHaveLength(ports.length), { timeout: 15_000 });
  return lags.map((record) => record.p90);
}

/**
 * How many of the sync test's 4 flashes must be drawn. Under heavy load the
 * output drops frames, as it should when one is late, and counts them; a
 * dropped flash has no draw time to compare. Every flash that is drawn must
 * still be within one output frame of its tone.
 */
const MIN_FLASHES_DRAWN = 2;
/** 0 to {@link LOAD_LAG}: how far behind the clock a drawn frame is checked. */
const BEHIND = Array.from({ length: LOAD_LAG + 1 }, (_, frames) => frames);

/** When each tone starts on the timeline, in samples, from the windows scheduled. */
function toneOnsets(
  windows: readonly ScheduledWindow[],
): { sample: number; window: ScheduledWindow }[] {
  const onsets: { sample: number; window: ScheduledWindow }[] = [];
  let quietSince = Number.NEGATIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const window of [...windows].sort((a, b) => a.from - b.from)) {
    const samples = window.channels[0] as Float32Array;
    for (let k = 0; k < samples.length; k += 1) {
      const sample = window.from + k;
      if (sample <= last) continue;
      last = sample;
      if (Math.abs(samples[k] as number) > 0.05) {
        // A tone after at least 100 ms of silence.
        if (sample - quietSince > 4_800) onsets.push({ sample, window });
        quietSince = sample;
      }
    }
  }
  return onsets;
}

/** The wall-clock time a context time is heard, from the context's own output timestamp. */
function heardAt(context: AudioContext, time: number): number {
  const stamp = context.getOutputTimestamp();
  // WebKit on Linux stamps another timeline: only a stamp near now is used.
  if (
    stamp.contextTime &&
    stamp.performanceTime !== undefined &&
    Math.abs(performance.now() - stamp.performanceTime) <= 200
  ) {
    return performance.timeOrigin + stamp.performanceTime + (time - stamp.contextTime) * 1_000;
  }
  const latency = context.outputLatency || context.baseLatency || 0;
  return (
    performance.timeOrigin + performance.now() + (time - context.currentTime + latency) * 1_000
  );
}

describe("audio as the clock", () => {
  let output: VideoOutput | undefined;
  let windows: ScheduledWindow[] = [];
  afterEach(async () => {
    await output?.destroy();
    output = undefined;
    audioTrace.onSchedule = null;
  });

  const trace = () => {
    windows = [];
    audioTrace.onSchedule = (window) => windows.push(window);
  };

  it("plays silently on the performance clock when autoplay blocks audio, and says so", async () => {
    // Blocked explicitly, as autoplay rules block it, rather than relying on
    // this browser's policy and on no gesture earlier in the page: a context
    // that stays suspended, whose resume never settles.
    class BlockedAudioContext extends AudioContext {
      override get state(): AudioContextState {
        return "suspended";
      }
      override resume(): Promise<void> {
        return new Promise(() => {});
      }
    }
    vi.stubGlobal("AudioContext", BlockedAudioContext);
    try {
      const real = await setup(numberedBeeps);
      output = real.output;
      trace();
      output.load(planOf(clipOf("a", real.source, 0, 90)));
      await shown();
      await output.play();
      expect(output.getSnapshot()).toMatchObject({ state: "playing", audio: "blocked" });
      await sleep(500);
      expect(output.position()).toBeGreaterThan(8);
      expect(windows).toEqual([]);
      output.pause();
      await noFramesOpen();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("draws each flash within one output frame of when its tone is heard, across cuts", async (context) => {
    await needAudio(context);
    const real = await setup(numberedBeeps);
    output = real.output;
    trace();
    // Source seconds 2–4, then 0–2: tones at timeline frames 15, 45, 75 and 105.
    const plan = planOf(clipOf("b", real.source, 2_000_000, 60), clipOf("a", real.source, 0, 60));
    output.load(plan);
    await shown();
    const since = performance.timeOrigin + performance.now();
    const pageLag = await runnerLag(async () => {
      await playFromGesture(output as VideoOutput);
      expect(output?.getSnapshot().audio).toBe("ready");
      await vi.waitFor(() => expect(output?.getSnapshot().state).toBe("stopped"), {
        timeout: 10_000,
      });
    });
    // The draw times come from the worker's thread, so its lag counts too:
    // the larger of the page's and the workers', over the playback.
    const lag = Math.max(pageLag, ...(await workerLags(since)));
    // One output frame, the runner's stated jitter, and its measured lag.
    const allowance = 1_000 / 30 + RUNNER_JITTER + lag;
    const onsets = toneOnsets(windows);
    // The context runs at the device's rate, such as 44.1 kHz.
    const sampleRate = windows[0]?.context.sampleRate as number;
    expect(onsets.map((onset) => Math.round((onset.sample * 30) / sampleRate))).toEqual([
      15, 45, 75, 105,
    ]);
    const rate = windows[0]?.context.sampleRate as number;
    const dropped = output.getSnapshot().droppedFrames;
    let measured = 0;
    for (const [index, flash] of [75, 105, 15, 45].entries()) {
      const onset = onsets[index] as { sample: number; window: ScheduledWindow };
      const heard = heardAt(
        onset.window.context,
        onset.window.at + (onset.sample - onset.window.from) / rate,
      );
      const drawnAt = drawn.find((record) => record.clock !== null && record.number === flash);
      if (drawnAt === undefined) {
        // A loaded runner drops frames, which the output counts: a flash it
        // dropped is allowed, if counted, and has no draw time to compare.
        expect(dropped, `flash ${flash} neither drawn nor counted dropped`).toBeGreaterThan(0);
        continue;
      }
      measured += 1;
      const apart = drawnAt.wall - heard;
      expect(
        Math.abs(apart),
        `flash ${flash}: ${apart.toFixed(1)} ms from its tone, allowing ${allowance.toFixed(1)} ms with the runner's ${lag.toFixed(1)} ms lag`,
      ).toBeLessThanOrEqual(allowance);
    }
    // Most flashes are drawn and measured even under heavy load; every one
    // that's drawn is within one output frame of its tone.
    expect(
      measured,
      `only ${measured} of 4 flashes drawn; ${dropped} frames dropped`,
    ).toBeGreaterThanOrEqual(MIN_FLASHES_DRAWN);
    await noFramesOpen();
    expect(audioLedger.scheduled).toBe(0);
  });

  it("mutes during playback without a gap, and releases every window", async (context) => {
    await needAudio(context);
    const real = await setup(numberedBeeps);
    output = real.output;
    trace();
    const loud = planOf(clipOf("a", real.source, 0, 120));
    output.load(loud);
    await shown();
    await playFromGesture(output);
    await sleep(700);
    const before = windows.length;
    const clip = loud.clips[0] as VideoPlan["clips"][number];
    output.load({ ...loud, clips: [{ ...clip, muted: true }] });
    await sleep(2_000);
    // Every window starts where the one before ended: no gap at the switch.
    const sorted = windows
      .filter((window, index) => index < before || window.from >= (windows[before]?.from ?? 0))
      .sort((a, b) => a.from - b.from);
    const rate = sorted[0]?.context.sampleRate as number;
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1] as ScheduledWindow;
      const current = sorted[index] as ScheduledWindow;
      expect(current.at).toBeCloseTo(previous.at + (current.from - previous.from) / rate, 6);
    }
    // After the switch, silence: the tones at 1.5 and 2.5 s are muted.
    const after = windows.slice(before);
    expect(after.length).toBeGreaterThan(2);
    expect(
      after.every((window) => (window.channels[0] as Float32Array).every((s) => s === 0)),
    ).toBe(true);
    output.stop();
    await noFramesOpen();
    expect(audioLedger.scheduled).toBe(0);
    const audio = windows[0]?.context as AudioContext;
    await output.destroy();
    output = undefined;
    expect(audio.state).toBe("closed");
  });
});
