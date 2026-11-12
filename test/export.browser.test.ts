import { createWorkerClient } from "@hussmartinez/sdk-core";
import { describe, expect, it, vi } from "vitest";
import { createVideoEngine, engineInternals } from "../src/adapters/video-engine.js";
import { createVideoProcessor } from "../src/adapters/video-processor.js";
import { isVideoError, VideoError, videoLimits } from "../src/index.js";
import { clipOf, planOf } from "./contracts/helpers.js";
import {
  describeVideoProcessorContract,
  type VideoProcessorHarness,
} from "./contracts/video-processor.contract.js";
import exportA from "./fixtures/video/export-a.webm?url";
import exportB from "./fixtures/video/export-b.webm?url";
import { unreadable } from "./support/codecs.js";
import type { ExportTestContract } from "./workers/export.worker.js";
import type { InspectContract } from "./workers/inspect.worker.js";

// Exports over the real engine and processor (docs/adr/0005), in every
// browser engine, read back by decoding the exported file in the same engine.

const FRAME = 1_000_000 / 30;

const inspector = createWorkerClient<InspectContract>({
  createWorker: () =>
    new Worker(new URL("./workers/inspect.worker.ts", import.meta.url), { type: "module" }),
  errorClasses: { VideoError },
});

const blob = async (url: string) => (await fetch(url)).blob();

const exporter = createWorkerClient<ExportTestContract>({
  createWorker: () =>
    new Worker(new URL("./workers/export.worker.ts", import.meta.url), { type: "module" }),
  errorClasses: { VideoError },
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the export to fail");
}

async function setup() {
  const engine = createVideoEngine();
  const open = async (id: string, url: string) => {
    const file = await blob(url);
    return engine.open(id, file, await engine.probe(file));
  };
  const a = await open("a", exportA);
  const b = await open("b", exportB);
  const processor = createVideoProcessor({ engine });
  return {
    processor,
    a,
    b,
    async teardown() {
      await processor.destroy();
      await engine.destroy();
    },
  };
}

/** A plan at the fixtures' size, so their blocks read back one to one. */
function smallPlan(...clips: Parameters<typeof planOf>) {
  const plan = planOf(...clips);
  return { ...plan, output: { ...plan.output, width: 256, height: 32 } };
}

const harness: VideoProcessorHarness = {
  async setup() {
    const real = await setup();
    // The contract's plans are 1280 × 720; the export's output is the fixtures' size.
    const processor = {
      export: (
        job: Parameters<typeof real.processor.export>[0],
        options?: Parameters<typeof real.processor.export>[1],
      ) =>
        real.processor.export(
          { ...job, plan: { ...job.plan, output: { ...job.plan.output, width: 256, height: 32 } } },
          options,
        ),
      destroy: () => real.processor.destroy(),
    };
    return { processor, a: real.a, b: real.b, teardown: real.teardown };
  },
  async inspect(file) {
    const { numbers, metadata } = await inspector.call("inspect", file);
    return {
      frames: numbers.map((number) => ({
        source: number >= 128 ? "b" : "a",
        time: Math.round((number % 128) * FRAME),
      })),
      metadata,
    };
  },
  timeTolerance: 1,
  unavailable: () => unreadable(),
};

describeVideoProcessorContract("the SDK's processor", harness);

describe("an export's file", () => {
  it("is MP4 by default, with H.264, and audio from the sources, on the output's timeline", async (context) => {
    const reason = await unreadable();
    if (reason) context.skip(reason);
    const { processor, a, teardown } = await setup();
    const file = await processor.export({ plan: smallPlan(clipOf("x", a, 0, 30)) });
    const read = await inspector.call("inspect", file);
    expect(read.container).toBe("mp4");
    expect(read.videoCodec).toMatch(/^avc1\./);
    expect(["mp4a.40.2", "opus"]).toContain(read.audioCodec);
    expect(read.numbers).toEqual([...Array(30).keys()]);
    // On the output's frame grid, within the microsecond a container's timescale rounds to.
    for (const [index, timestamp] of read.timestamps.entries()) {
      expect(Math.abs(timestamp - Math.round(index * FRAME))).toBeLessThanOrEqual(1);
    }
    await teardown();
  });

  it("writes WebM when asked, with VP9 or VP8 and Opus", async (context) => {
    const reason = await unreadable("webm");
    if (reason) context.skip(reason);
    const { processor, b, teardown } = await setup();
    const file = await processor.export({
      plan: smallPlan(clipOf("x", b, 1_000_000, 15)),
      container: "webm",
    });
    const read = await inspector.call("inspect", file);
    expect(read.container).toBe("webm");
    expect(read.videoCodec).toMatch(/^(vp09\.|vp8)/);
    expect(read.audioCodec).toBe("opus");
    expect(read.numbers).toEqual([...Array(15).keys()].map((n) => 128 + 30 + n));
    await teardown();
  });

  it("fails with FILE_TOO_LARGE as soon as the file passes maxFileSize, warning first, and holds nothing", async () => {
    const engine = createVideoEngine();
    const file = await blob(exportA);
    const a = await engine.open("a", file, await engine.probe(file));
    const source = engineInternals(engine)?.source("a");
    if (!source) throw new Error("expected the source to be open");
    const limits = videoLimits.resolve({ maxFileSize: { maximum: 12_000, warning: 6_000 } }).limits;
    const warnings: string[] = [];
    let fraction = 0;
    const started = performance.now();
    const error = await failure(
      exporter.call(
        "export",
        { plan: smallPlan(clipOf("x", a, 0, 90)), sources: [source], limits },
        {
          onProgress: (update) => {
            if (typeof update === "number") fraction = update;
            else warnings.push(update.warning);
          },
        },
      ),
    );
    expect(isVideoError(error, "FILE_TOO_LARGE")).toBe(true);
    expect((error as VideoError).details).toMatchObject({ limit: "maxFileSize", maximum: 12_000 });
    expect(warnings).toEqual(["maxFileSize"]);
    // It stopped when the file passed the limit, well before the end.
    expect(fraction).toBeLessThan(1);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(await exporter.call("ledger", undefined)).toEqual({ frames: 0, decoded: 0, audio: 0 });
    await engine.destroy();
  });

  it("reports the warning and the limit through the processor", async () => {
    const engine = createVideoEngine();
    const file = await blob(exportA);
    const a = await engine.open("a", file, await engine.probe(file));
    const processor = createVideoProcessor({
      engine,
      filePolicy: videoLimits.resolve({ maxFileSize: { maximum: 12_000, warning: 6_000 } }),
    });
    const warnings: string[] = [];
    const error = await failure(
      processor.export(
        { plan: smallPlan(clipOf("x", a, 0, 90)) },
        { onWarning: (limit) => warnings.push(limit) },
      ),
    );
    expect(isVideoError(error, "FILE_TOO_LARGE")).toBe(true);
    expect(warnings).toEqual(["maxFileSize"]);
    await processor.destroy();
    await engine.destroy();
  });

  it("holds no frame or audio after an export is cancelled partway", async () => {
    const engine = createVideoEngine();
    const file = await blob(exportA);
    const a = await engine.open("a", file, await engine.probe(file));
    const source = engineInternals(engine)?.source("a");
    if (!source) throw new Error("expected the source to be open");
    const controller = new AbortController();
    const error = await failure(
      exporter.call(
        "export",
        {
          plan: smallPlan(clipOf("x", a, 0, 90)),
          sources: [source],
          limits: videoLimits.resolve().limits,
        },
        {
          signal: controller.signal,
          onProgress: (update) => {
            if (typeof update === "number" && update > 0) controller.abort();
          },
        },
      ),
    );
    // Straight from the worker's client: sdk-core's own error, with its code.
    expect((error as { code?: unknown }).code).toBe("ABORTED");
    await vi.waitFor(async () =>
      expect(await exporter.call("ledger", undefined)).toEqual({ frames: 0, decoded: 0, audio: 0 }),
    );
    await engine.destroy();
  });
});
