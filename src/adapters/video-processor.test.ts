import { describe, expect, it } from "vitest";
import { clipOf, planOf } from "../../test/contracts/helpers.js";
import { isVideoError } from "../core/errors/video-error.js";
import { videoLimits } from "../core/errors/video-limits.js";
import type { VideoSourceInfo } from "../core/model/source.js";
import type { ExportOutcome } from "./export-worker/export-plan.js";
import type { ExportRunner } from "./export-worker/runner.js";
import type { PlaybackSource } from "./media-worker/contract.js";
import { createProcessor } from "./video-processor.js";

const source = { id: "source-1", duration: 2_000_000 } as VideoSourceInfo;
const plan = planOf(clipOf("a", source, 0, 30));
const outcome = {
  file: new Blob(["exported"]),
  container: "mp4",
  peak: 0.5,
  clippedFrames: 0,
} as ExportOutcome;

/** A processor whose export code loads when the test says, and records each run. */
function slowlyLoaded() {
  const runs: AbortSignal[] = [];
  let loaded!: () => void;
  const loading = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const runner: ExportRunner = {
    async run(_request, _policy, options) {
      if (options.signal) runs.push(options.signal);
      return outcome;
    },
    destroy() {},
  };
  const processor = createProcessor({
    source: (id) => (id === source.id ? ({ id } as unknown as PlaybackSource) : undefined),
    policy: videoLimits.resolve(),
    loadRunner: async () => {
      await loading;
      return runner;
    },
  });
  return { processor, runs, loaded };
}

describe("the processor", () => {
  it("never starts an export stopped while its code loads, and is free for the next one", async () => {
    const { processor, runs, loaded } = slowlyLoaded();
    const controller = new AbortController();
    const first = processor.export({ plan }, { signal: controller.signal });
    // Stopped, as by closing the export dialog, before the runner has loaded.
    controller.abort();
    loaded();
    const failure = await first.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isVideoError(failure, "ABORTED")).toBe(true);
    expect(runs).toEqual([]);
    // Not BUSY: nothing of the stopped export is left running.
    await expect(processor.export({ plan })).resolves.toMatchObject({ container: "mp4" });
  });
});
