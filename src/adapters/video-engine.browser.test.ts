import { describe, expect, it } from "vitest";
import { describeVideoEngineContract } from "../../test/contracts/video-engine.contract.js";
import landscapeMp4 from "../../test/fixtures/video/landscape.mp4?url";
import rotatedMov from "../../test/fixtures/video/rotated.mov?url";
import silentMp4 from "../../test/fixtures/video/silent.mp4?url";
import tinyMp4 from "../../test/fixtures/video/tiny.mp4?url";
import { isVideoError } from "../core/errors/video-error.js";
import { createVideoEngine } from "./video-engine.js";

async function bytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** landscape.mp4 with its movie header claiming one second instead of two. */
async function lyingHeader(): Promise<Blob> {
  const file = await bytes(landscapeMp4);
  const at = [...file.keys()].find(
    (i) => file[i] === 0x6d && file[i + 1] === 0x76 && file[i + 2] === 0x68 && file[i + 3] === 0x64,
  ) as number;
  const view = new DataView(file.buffer);
  // After the type: version and flags, two times, the timescale, then the duration.
  view.setUint32(at + 20, view.getUint32(at + 16));
  return new Blob([file]);
}

// The SDK's own engine, with its inlined media worker, against the same
// contract as the fakes, in each browser engine.
describeVideoEngineContract("video engine", {
  createEngine: () => createVideoEngine(),
  landscape: async () => new Blob([await bytes(landscapeMp4)]),
  rotated: async () => new Blob([await bytes(rotatedMov)]),
  silent: async () => new Blob([await bytes(silentMp4)]),
  lyingHeader,
  malformed: async () => new Blob([(await bytes(tinyMp4)).subarray(0, 2_000)]),
  unknown: async () => new Blob(["GIF89a, not a video"]),
  // The generated files' audio runs about 21 ms past their 2 s of video.
  tolerance: { frameRate: 0, duration: 100_000 },
});

describe("opening a probe the engine didn't make", () => {
  it("probes the file again, and refuses a probe that doesn't describe it", async () => {
    const engine = createVideoEngine();
    const file = new Blob([await bytes(landscapeMp4)]);
    const probe = await engine.probe(file);
    await expect(engine.open("copy", file, structuredClone(probe))).resolves.toMatchObject({
      id: "copy",
    });
    // A probe claiming a smaller frame, to pass the limits, isn't believed.
    const forged = structuredClone(probe);
    const smaller = { ...forged, video: { ...forged.video, codedWidth: 64, codedHeight: 36 } };
    let error: unknown;
    try {
      await engine.open("forged", file, smaller);
    } catch (caught) {
      error = caught;
    }
    expect(isVideoError(error, "INVALID_VIDEO")).toBe(true);
    await engine.destroy();
  });
});
