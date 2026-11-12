import { describe, expect, it } from "vitest";
import { describeVideoEngineContract } from "../../test/contracts/video-engine.contract.js";
import hevcMp4 from "../../test/fixtures/video/hevc.mp4?url";
import landscapeMp4 from "../../test/fixtures/video/landscape.mp4?url";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import rotatedMov from "../../test/fixtures/video/rotated.mov?url";
import silentVp8 from "../../test/fixtures/video/silent-vp8.webm?url";
import tinyMp4 from "../../test/fixtures/video/tiny.mp4?url";
import { isVideoError } from "../core/errors/video-error.js";
import { videoLimits } from "../core/errors/video-limits.js";
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
  // VP8 and Opus, which every engine in the test matrix decodes (docs/capabilities.md).
  landscape: async () => new Blob([await bytes(landscapeVp8)]),
  // HEVC, where this browser can't decode it: Chromium and Firefox can't,
  // while the image's WebKit claims it can (docs/capabilities.md).
  async undecodable() {
    const hevc = { codec: "hvc1.1.6.L93.B0", codedWidth: 320, codedHeight: 180 };
    if ((await VideoDecoder.isConfigSupported(hevc)).supported) return undefined;
    return new Blob([await bytes(hevcMp4)]);
  },
  rotated: async () => new Blob([await bytes(rotatedMov)]),
  silent: async () => new Blob([await bytes(silentVp8)]),
  lyingHeader,
  malformed: async () => new Blob([(await bytes(tinyMp4)).subarray(0, 2_000)]),
  unknown: async () => new Blob(["GIF89a, not a video"]),
  // The generated files' audio runs about 21 ms past their 2 s of video.
  tolerance: { frameRate: 0, duration: 100_000 },
});

describe("the support check when opening", () => {
  it("runs the front check again under the caller's policy before mediabunny reads the file", async () => {
    const engine = createVideoEngine();
    const file = new Blob([await bytes(landscapeVp8)]);
    const probe = await engine.probe(file);
    // A trusted probe skips the re-probe, but not the support step's own
    // front check, which applies the policy given to open.
    let error: unknown;
    try {
      await engine.open("a", file, probe, {
        filePolicy: videoLimits.resolve({ maxIndexSize: 10 }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(isVideoError(error, "INDEX_TOO_LARGE")).toBe(true);
    await expect(engine.open("a", file, probe)).resolves.toMatchObject({ id: "a" });
    await engine.destroy();
  });
});
