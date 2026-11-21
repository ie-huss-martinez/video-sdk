import { describe, expect, it, vi } from "vitest";
import { clipOf, planOf } from "../../test/contracts/helpers.js";
import { isVideoError } from "../core/errors/video-error.js";
import { videoLimits } from "../core/errors/video-limits.js";
import type { VideoSourceInfo } from "../core/model/source.js";
import { createExportRunner } from "./export-worker/runner.js";
import { createInlineExportWorker, createInlineWorker } from "./no-inline-workers.js";

// A build with the hm-self-hosted condition gets this module instead of the
// inlined workers (sdk-core ADR 0060).
vi.mock("#hm-video-media-worker", () => import("./no-inline-workers.js"));

const leftOut = (error: unknown) =>
  isVideoError(error, "WORKER_START_FAILED") &&
  error.message.includes("hm-self-hosted") &&
  error.message.includes("assetsUrl") &&
  JSON.stringify(error.details) ===
    JSON.stringify({ condition: "hm-self-hosted", missing: "assetsUrl" });

describe("the stub for a build without inlined workers (sdk-core ADR 0060)", () => {
  it("refuses to start the media worker, naming the condition and the missing assetsUrl", () => {
    expect(() => createInlineWorker()).toThrow(
      expect.toSatisfy(leftOut, "WORKER_START_FAILED naming hm-self-hosted and assetsUrl"),
    );
  });

  it("refuses to start the export worker the same way", () => {
    expect(() => createInlineExportWorker()).toThrow(expect.toSatisfy(leftOut, "the same error"));
  });

  it("reaches an engine's caller unchanged, when a build needs the inlined worker", async () => {
    const { createVideoEngine } = await import("./video-engine.js");
    const engine = createVideoEngine();
    try {
      await expect(engine.probe(new Blob([new Uint8Array(16)]))).rejects.toSatisfy(leftOut);
    } finally {
      await engine.destroy();
    }
  });

  it("reaches an export's caller unchanged, when a build needs the inlined export worker", async () => {
    const runner = createExportRunner(createInlineExportWorker as () => Worker);
    const source = { id: "source-1", duration: 2_000_000 } as VideoSourceInfo;
    try {
      await expect(
        runner.run(
          { plan: planOf(clipOf("a", source, 0, 30)), sources: [] },
          videoLimits.resolve(),
          {},
        ),
      ).rejects.toSatisfy(leftOut);
    } finally {
      runner.destroy();
    }
  });
});
