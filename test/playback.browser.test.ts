import { afterEach, describe, expect, it, vi } from "vitest";
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
import numberedVp8 from "./fixtures/video/numbered-vp8.webm?url";
import type { DrawnRecord, LedgerRecord, TestPortMessage } from "./workers/playback.worker.js";

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
/** The ports to the workers the current test started. */
const ports: MessagePort[] = [];

/** Starts a playback test worker, with a port for its reports. */
function startWorker(): Worker {
  const worker = new Worker(new URL("./workers/playback.worker.ts", import.meta.url), {
    type: "module",
  });
  const channel = new MessageChannel();
  channel.port1.addEventListener("message", (event: MessageEvent<DrawnRecord | LedgerRecord>) => {
    if (event.data.type === "drawn") drawn.push(event.data);
    else ledgers.push(event.data);
  });
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

async function setup() {
  for (const port of ports.splice(0)) port.close();
  const engine = createEngine({ loadWorker: async () => startWorker });
  const file = await (await fetch(numberedVp8)).blob();
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

/** Waits for the next frame drawn while paused, and returns its number. */
async function shown(): Promise<number> {
  await vi.waitFor(() => expect(drawn.some((record) => record.clock === null)).toBe(true), {
    timeout: 5_000,
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
      for (const ledger of ledgers) expect(ledger).toMatchObject({ open: 0, held: 0 });
    },
    { timeout: 5_000, interval: 50 },
  );
}

const harness: VideoOutputHarness = {
  async create() {
    const { output, source } = await setup();
    return { output, source, elapse: (frames) => sleep((frames * 1_000) / 30) };
  },
  // Timers in a busy headless browser run late by a few frames.
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
      const behind = [0, 1, 2].find((d) => {
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
      const matches = [0, 1, 2].some((d) => {
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
