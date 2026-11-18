import { describe, expect, it } from "vitest";
import { clipOf, planOf } from "../../../test/contracts/helpers.js";
import { isVideoError } from "../../core/errors/video-error.js";
import { videoLimits } from "../../core/errors/video-limits.js";
import type { VideoSourceInfo } from "../../core/model/source.js";
import { createExportRunner } from "./runner.js";

describe("the export runner", () => {
  it("rejects a run whose signal is already aborted with ABORTED, and starts no worker for it", async () => {
    let started = 0;
    const runner = createExportRunner(() => {
      started += 1;
      throw new Error("no worker should start for a stopped export");
    });
    const controller = new AbortController();
    controller.abort();
    const source = { id: "source-1", duration: 2_000_000 } as VideoSourceInfo;
    const failure = await runner
      .run({ plan: planOf(clipOf("a", source, 0, 30)), sources: [] }, videoLimits.resolve(), {
        signal: controller.signal,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // Its stop is passed on: without it, the export would run to its end.
    expect(isVideoError(failure, "ABORTED")).toBe(true);
    expect(started).toBe(0);
    runner.destroy();
  });
});
