import { audioOutput } from "@hussmartinez/sdk-config/testing/audio-output";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  audioLedger,
  audioTrace,
  FUTURE_STAMP,
  PLAUSIBLE_STAMP,
  type ScheduledWindow,
} from "../src/adapters/playback-audio.js";
import { createEngine } from "../src/adapters/video-engine.js";
import { createVideoOutput } from "../src/adapters/video-output.js";
import {
  clipOffsets,
  locateFrame,
  planFrames,
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

// Real decoding and playback run in workers, and a loaded machine slows them.
// The waits inside name a hang, not the test's timeout: each waits on frames
// being decoded and drawn, and gets 30 s, well before WebKit's page died in
// verify run 44410142740, about 44 s after its last progress, and before
// the family's 60 s a test (sdk-core ADR 0057).

/** How long a wait on frames being decoded and drawn gets. */
const WORK_WAIT = 30_000;

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

/** Where on the plan's timeline a clip's source frame is shown, in output frames, or -1. */
function placeIn(
  plan: VideoPlan,
  record: { readonly clip: string; readonly number: number },
): number {
  for (let frame = 0; frame < planFrames(plan); frame += 1) {
    const expected = planned(plan, frame);
    if (expected?.clip === record.clip && expected.number === record.number) return frame;
  }
  return -1;
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
    timeout: WORK_WAIT,
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
    { timeout: WORK_WAIT, interval: 50 },
  );
}

/**
 * Readers opened and released now, summed over every worker the test
 * started: the engine's and the output's both run the test worker.
 */
async function readersNow(
  plans = 0,
): Promise<{ readonly opened: number; readonly released: number; readonly plans: number }> {
  let total = { opened: 0, released: 0, plans: 0 };
  await vi.waitFor(
    async () => {
      ledgers = [];
      for (const port of ports) port.postMessage({ type: "ledger" });
      await sleep(20);
      expect(ledgers).toHaveLength(ports.length);
      total = {
        opened: ledgers.reduce((sum, ledger) => sum + ledger.readersOpened, 0),
        released: ledgers.reduce((sum, ledger) => sum + ledger.readersReleased, 0),
        plans: ledgers.reduce((sum, ledger) => sum + ledger.plansLoaded, 0),
      };
      // The ledger travels on its own port: wait until the worker has taken
      // the plans sent before it.
      expect(total.plans).toBeGreaterThanOrEqual(plans);
    },
    { timeout: WORK_WAIT, interval: 50 },
  );
  return total;
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
      timeout: WORK_WAIT,
    });
    const playing = drawn.filter((record) => record.clock !== null);
    // What holds however slow the machine is (docs/adr/0006): each frame is
    // the plan's frame for some place, never drawn before the clock reaches
    // it, and never after a later one. How late frames run, and how smoothly,
    // is the decoder's speed, which the scheduler's unit tests pin with a
    // decoder of known speed.
    let previous = Number.NEGATIVE_INFINITY;
    for (const record of playing) {
      // The pixels are the frame the worker meant to draw.
      expect(record.number).toBe(Math.round(record.sourceTime / FRAME));
      const at = Math.min(frameOf(record.clock as number), 89);
      const place = placeIn(plan, record);
      const where = `frame ${record.number} of ${record.clip} at ${at}`;
      expect(place, `${where}: not a frame the plan shows`).toBeGreaterThanOrEqual(0);
      expect(place, `${where}: drawn before its place`).toBeLessThanOrEqual(at);
      expect(place, `${where}: drawn after a later one`).toBeGreaterThan(previous);
      previous = place;
    }
    const order = playing.map((record) => `${record.clip}${record.number}`);
    const dropped = output.getSnapshot().droppedFrames ?? 0;
    // Every frame was drawn or counted dropped. Checked first, so a failure
    // below still shows whether a frame missing at the cut was counted.
    const distinct = new Set(order).size;
    expect(distinct + dropped, `${distinct} drawn, ${dropped} dropped`).toBeGreaterThanOrEqual(88);
    // Across the cut, in the plan's order: something of clip b, after the
    // last of clip a. Not b0 itself, which the late-frame rule may drop for a
    // later frame when the restart at the cut runs late (docs/adr/0006).
    const firstOfB = order.findIndex((each) => each.startsWith("b"));
    const lastOfA = order.reduce((last, each, index) => (each.startsWith("a") ? index : last), -1);
    const around = `${order.slice(Math.max(0, lastOfA - 1), lastOfA + 3).join(",")}; ${dropped} dropped`;
    expect(firstOfB, `nothing of clip b drawn: ${around}`).toBeGreaterThanOrEqual(0);
    expect(firstOfB, `clip b drawn before the end of clip a: ${around}`).toBeGreaterThan(lastOfA);
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

  it("keeps playing through many plans that change only the sound, drawing every frame from the same decoder", async () => {
    const real = await setup();
    output = real.output;
    const base = planOf(clipOf("a", real.source, 0, 120));
    output.load(base);
    await shown();
    await output.play();
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(3), { timeout: WORK_WAIT });
    // Every failure, even one a later load clears from the snapshot.
    const failures: string[] = [];
    const unsubscribe = output.subscribe(() => {
      const error = output?.getSnapshot().error;
      if (error) failures.push(`${error.code} ${JSON.stringify(error.details)}`);
    });
    // A volume slider dragged while playing: a plan every 50 ms, picture unchanged.
    const clip = base.clips[0] as VideoPlan["clips"][number];
    for (let step = 0; step < 20; step += 1) {
      output.load({ ...base, clips: [{ ...clip, volumeDb: -step }] });
      await sleep(50);
    }
    // Still drawing, frame after frame.
    const count = drawn.length;
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(count + 3), { timeout: WORK_WAIT });
    unsubscribe();
    expect(failures).toEqual([]);
    expect(output.getSnapshot().state).toBe("playing");
    output.pause();
    await noFramesOpen();
  });

  it("opens no reader again and releases none for plans that change only the sound, at the worker's boundary", async () => {
    const real = await setup();
    output = real.output;
    const base = planOf(clipOf("a", real.source, 0, 120));
    output.load(base);
    await shown();
    await output.play();
    // The reader is in use: frames are being decoded from it.
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(3), { timeout: WORK_WAIT });
    const before = await readersNow();
    expect(before.opened).toBeGreaterThan(0);
    const clip = base.clips[0] as VideoPlan["clips"][number];
    const changes: VideoPlan["clips"][number][] = [
      { ...clip, muted: true },
      { ...clip, volumeDb: -12 },
      { ...clip, fadeIn: { duration: 500_000, curve: "equalPower" } },
    ];
    // Each crosses to the worker as a message, which clones the source's Blob.
    for (const change of changes) output.load({ ...base, clips: [change] });
    // Counted when the worker takes each plan, not when a read happens to
    // fail: the same answer wherever the loads land between packet reads.
    expect(await readersNow(before.plans + changes.length)).toEqual({
      opened: before.opened,
      released: before.released,
      plans: before.plans + changes.length,
    });
    // A plan without the source does release its reader.
    output.load(planOf());
    await vi.waitFor(
      async () => expect((await readersNow()).released).toBeGreaterThan(before.released),
      {
        timeout: WORK_WAIT,
      },
    );
    output.pause();
    await noFramesOpen();
  });

  it("keeps playing after a mute while playing, from the same decoder", async () => {
    const real = await setup();
    output = real.output;
    const base = planOf(clipOf("a", real.source, 0, 120));
    output.load(base);
    await shown();
    await output.play();
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(3), { timeout: WORK_WAIT });
    const failures: string[] = [];
    const unsubscribe = output.subscribe(() => {
      const error = output?.getSnapshot().error;
      if (error) failures.push(`${error.code} ${JSON.stringify(error.details)}`);
    });
    const clip = base.clips[0] as VideoPlan["clips"][number];
    output.load({ ...base, clips: [{ ...clip, muted: true }] });
    const count = drawn.length;
    // Frames keep coming: the decoder wasn't stopped by the new plan.
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(count + 10), {
      timeout: WORK_WAIT,
    });
    unsubscribe();
    expect(failures).toEqual([]);
    expect(output.getSnapshot().state).toBe("playing");
    output.pause();
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
    // The file's own timeout, not the default second: a loaded machine redraws late.
    await vi.waitFor(() => expect(drawn.some((record) => record.clock === null)).toBe(true), {
      timeout: WORK_WAIT,
    });
    expect(drawn[0]).toMatchObject({ number: 40, width: 512, height: 64 });
    drawn = [];
    // Taller than the output: letterboxed above and below.
    output.resize(256, 128);
    output.step(1);
    await vi.waitFor(() => expect(drawn.some((record) => record.number === 41)).toBe(true), {
      timeout: WORK_WAIT,
    });
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
    // How soon the new plan's frames arrive is the machine's speed, not the
    // scheduler's: under load the decoders restart slowly and frames are
    // dropped. So this waits for them rather than for a fixed time, and
    // checks every one that's drawn.
    const ofEdit = () => drawn.filter((record) => record.clip === "x" || record.clip === "y");
    await vi.waitFor(() => expect(ofEdit().length).toBeGreaterThan(5), {
      timeout: WORK_WAIT,
      interval: 50,
    });
    // What holds however slow the machine is (docs/adr/0006): every frame drawn
    // is the new plan's frame for some place on its timeline, never drawn
    // before the clock reaches that place, and places never go backwards. How
    // late a frame is after the restart is the decoder's speed, which the
    // scheduler's unit tests pin exactly with a decoder of known speed.
    const after = ofEdit();
    let previous = Number.NEGATIVE_INFINITY;
    for (const record of after) {
      const at = frameOf(record.clock as number);
      const place = placeIn(edited, record);
      const where = `frame ${record.number} of ${record.clip} at ${at}`;
      expect(place, `${where}: not a frame the new plan shows`).toBeGreaterThanOrEqual(0);
      expect(place, `${where}: drawn before its place`).toBeLessThanOrEqual(at);
      expect(place, `${where}: drawn after a later one`).toBeGreaterThan(previous);
      previous = place;
    }
    // And once the new plan's first frame is drawn, never the old plan's again.
    const firstNew = drawn.findIndex((record) => record.clip === "x" || record.clip === "y");
    expect(drawn.slice(firstNew).filter((record) => record.clip === "a")).toEqual([]);
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
  await vi.waitFor(() => expect(lags).toHaveLength(ports.length), { timeout: WORK_WAIT });
  return lags.map((record) => record.p90);
}

/**
 * How many of the sync test's 4 flashes must be drawn. Under heavy load the
 * output drops frames, as it should when one is late, and counts them; a
 * dropped flash has no draw time to compare. Every flash that is drawn must
 * still be within one output frame of its tone.
 */
const MIN_FLASHES_DRAWN = 2;

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

/** How {@link clockOffset} read the audio clock last: by the output timestamp, or the context's own time. */
let heardVia = "";

/**
 * The audio clock against the page's, now: a context time `t`, in seconds,
 * is heard at `performance.now()` time `offset + t × 1,000`. Read by the same
 * rule as the SDK's clock (docs/adr/0006): the output timestamp, unless it's
 * more than {@link PLAUSIBLE_STAMP} ms old or more than {@link FUTURE_STAMP}
 * ms in the future, as WebKit's is; then the context's own time and its
 * reported latency. Reading it by another rule would measure the difference
 * between the two rules, not the SDK's sync.
 */
function clockOffset(context: AudioContext): number {
  const stamp = context.getOutputTimestamp();
  const now = performance.now();
  const age = stamp.performanceTime === undefined ? Number.NaN : now - stamp.performanceTime;
  if (stamp.contextTime && age >= -FUTURE_STAMP && age <= PLAUSIBLE_STAMP) {
    heardVia = `the output timestamp, ${age.toFixed(1)} ms old`;
    return (stamp.performanceTime as number) - (stamp.contextTime as number) * 1_000;
  }
  const latency = context.outputLatency || context.baseLatency || 0;
  heardVia = `the context's time, with ${(latency * 1_000).toFixed(1)} ms latency (output ${context.outputLatency}, base ${context.baseLatency}); the stamp was ${age.toFixed(0)} ms old`;
  return now - (context.currentTime - latency) * 1_000;
}

/** One reading of {@link clockOffset}, and the `performance.now()` time it was read at. */
interface ClockSample {
  readonly at: number;
  readonly offset: number;
}

/** How often the sync test reads the audio clock while it plays, in milliseconds. */
const CLOCK_SAMPLE_INTERVAL = 20;

/**
 * How long before a draw the worker's anchor may have been read, in
 * milliseconds: the SDK sends a new one every 250 ms (docs/adr/0006), and a
 * loaded page sends it late.
 */
const ANCHOR_AGE = 300;

/**
 * When a context time was heard, as a wall-clock time, by the reading of the
 * audio clock made nearest to that moment. The clock isn't steady under
 * load: when the audio thread is starved, the context's time stops while the
 * page's goes on, so a reading made after playback places every earlier
 * tone late by all the stalls since.
 */
function heardAt(samples: readonly ClockSample[], time: number): number {
  let best = samples[0] as ClockSample;
  for (const sample of samples) {
    const distance = Math.abs(sample.at - (sample.offset + time * 1_000));
    if (distance < Math.abs(best.at - (best.offset + time * 1_000))) best = sample;
  }
  return performance.timeOrigin + best.offset + time * 1_000;
}

/**
 * How far the audio clock moved against the page's over the
 * {@link ANCHOR_AGE} before a wall-clock time, in milliseconds: near 0 on a
 * quiet machine. The worker draws by an anchor up to that old, so a stall of
 * the audio clock since then puts the picture ahead of the sound by as much,
 * until the next anchor. That's the design (docs/adr/0006), and a stall is
 * heard as a dropout anyway, so the sync check allows what it measured.
 */
function clockStall(samples: readonly ClockSample[], wall: number): number {
  const at = wall - performance.timeOrigin;
  const near = samples
    .filter((sample) => sample.at >= at - ANCHOR_AGE && sample.at <= at + CLOCK_SAMPLE_INTERVAL)
    .map((sample) => sample.offset);
  return near.length > 1 ? Math.max(...near) - Math.min(...near) : 0;
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
      // Every failure from the load on, even one a later play clears from the
      // snapshot, so a test that fails says why the output stopped.
      const failures: string[] = [];
      const unsubscribe = output.subscribe(() => {
        const error = output?.getSnapshot().error;
        if (error) {
          failures.push(`${error.code} ${JSON.stringify(error.details)} ${String(error.cause)}`);
        }
      });
      output.load(planOf(clipOf("a", real.source, 0, 90)));
      await shown();
      await output.play();
      unsubscribe();
      expect(failures).toEqual([]);
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
    // The audio clock, read while it plays: each tone is placed by the
    // reading nearest to it, not by one made after the playback.
    const clock: ClockSample[] = [];
    const sampler = setInterval(() => {
      const context = windows[0]?.context;
      if (context) clock.push({ at: performance.now(), offset: clockOffset(context) });
    }, CLOCK_SAMPLE_INTERVAL);
    let pageLag: number;
    try {
      pageLag = await runnerLag(async () => {
        await playFromGesture(output as VideoOutput);
        expect(output?.getSnapshot().audio).toBe("ready");
        await vi.waitFor(() => expect(output?.getSnapshot().state).toBe("stopped"), {
          timeout: WORK_WAIT,
        });
      });
    } finally {
      clearInterval(sampler);
    }
    expect(clock.length, "readings of the audio clock").toBeGreaterThan(0);
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
      const heard = heardAt(clock, onset.window.at + (onset.sample - onset.window.from) / rate);
      const drawnAt = drawn.find((record) => record.clock !== null && record.number === flash);
      if (drawnAt === undefined) {
        // A loaded runner drops frames, which the output counts: a flash it
        // dropped is allowed, if counted, and has no draw time to compare.
        expect(dropped, `flash ${flash} neither drawn nor counted dropped`).toBeGreaterThan(0);
        continue;
      }
      measured += 1;
      const apart = drawnAt.wall - heard;
      // What the audio clock itself stalled while the worker's anchor was in
      // use: measured, and near 0 unless the machine starved the audio.
      const stall = clockStall(clock, drawnAt.wall);
      expect(
        Math.abs(apart),
        `flash ${flash}: ${apart.toFixed(1)} ms from its tone, allowing ${(allowance + stall).toFixed(1)} ms with the runner's ${lag.toFixed(1)} ms lag and the audio clock's ${stall.toFixed(1)} ms stall; heard by ${heardVia}`,
      ).toBeLessThanOrEqual(allowance + stall);
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
