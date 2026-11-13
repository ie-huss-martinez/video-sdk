import { describe, expect, it } from "vitest";
import { createVideoEngine } from "../src/adapters/video-engine.js";
import { createVideoProcessor } from "../src/adapters/video-processor.js";
import { isVideoError, type VideoError } from "../src/index.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { clipOf, planOf } from "./contracts/helpers.js";
import exportA from "./fixtures/video/export-a.webm?url";
import { unreadable } from "./support/codecs.js";

// Self-hosted workers (sdk-core ADR 0038): the test server serves the files
// the build writes to dist/assets/, as built, and also built announcing
// another version.

const blob = async (url: string) => (await fetch(url)).blob();

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("self-hosted workers", () => {
  it("probes, opens and exports with the workers under assetsUrl", async (context) => {
    const engine = createVideoEngine({ assetsUrl: "/hm-test-assets/" });
    const file = await blob(exportA);
    const probe = await engine.probe(file);
    expect(probe.container).toBe("webm");
    const source = await engine.open("a", file, probe);
    const reason = await unreadable();
    if (reason) {
      await engine.destroy();
      context.skip(reason);
    }
    const processor = createVideoProcessor({ engine, assetsUrl: "/hm-test-assets/" });
    const plan = planOf(clipOf("x", source, 0, 10));
    const exported = await processor.export({
      plan: { ...plan, output: { ...plan.output, width: 256, height: 32 } },
    });
    expect(exported.size).toBeGreaterThan(1_000);
    await processor.destroy();
    await engine.destroy();
  });

  it("refuses a worker from another release, naming the asset and both versions", async () => {
    const engine = createVideoEngine({ assetsUrl: "/hm-test-assets-other-version/" });
    const error = await failure(engine.probe(await blob(exportA)));
    expect(isVideoError(error, "WORKER_START_FAILED")).toBe(true);
    expect((error as VideoError).details).toEqual({
      asset: "video/media.worker.js",
      expected: PACKAGE_VERSION,
      actual: "0.0.0-other",
    });
    await engine.destroy();

    const real = createVideoEngine();
    const file = await blob(exportA);
    const source = await real.open("a", file, await real.probe(file));
    const processor = createVideoProcessor({
      engine: real,
      assetsUrl: "/hm-test-assets-other-version/",
    });
    const exportError = await failure(
      processor.export({ plan: planOf(clipOf("x", source, 0, 10)) }),
    );
    expect(isVideoError(exportError, "WORKER_START_FAILED")).toBe(true);
    expect((exportError as VideoError).details).toMatchObject({ asset: "video/export.worker.js" });
    await processor.destroy();
    await real.destroy();
  });

  it("refuses an assetsUrl with a query or fragment when it's created", () => {
    expect(() => createVideoEngine({ assetsUrl: "/assets/?v=1" })).toThrow(TypeError);
    expect(() => createVideoEngine({ assetsUrl: "/assets/#x" })).toThrow(TypeError);
  });
});
