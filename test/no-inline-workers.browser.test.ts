import { expect, it, vi } from "vitest";
import { createVideoEngine } from "../src/adapters/video-engine.js";
import { isVideoError } from "../src/core/errors/video-error.js";

// A build with the hm-self-hosted condition gets the stub instead of the
// inlined media worker (sdk-core ADR 0060).
vi.mock("#hm-video-media-worker", () => import("../src/adapters/no-inline-workers.js"));

it("says why the media worker can't start in a build that left it out, without assetsUrl", async () => {
  const engine = createVideoEngine();
  try {
    await expect(engine.probe(new Blob([new Uint8Array(16)]))).rejects.toSatisfy(
      (error) =>
        isVideoError(error, "WORKER_START_FAILED") &&
        JSON.stringify(error.details) ===
          JSON.stringify({ condition: "hm-self-hosted", missing: "assetsUrl" }),
    );
  } finally {
    await engine.destroy();
  }
});
