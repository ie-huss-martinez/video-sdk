import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isVideoError } from "../core/errors/video-error.js";
import { type VideoFilePolicyOverrides, videoLimits } from "../core/errors/video-limits.js";
import { checkProbe } from "../core/model/probe-limits.js";
import { probeFile } from "./probe.js";

const FIXTURES = "test/fixtures/video";
const policy = videoLimits.resolve();

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${FIXTURES}/${name}`));
}

async function probe(
  bytes: Uint8Array,
  overrides: VideoFilePolicyOverrides = {},
  signal?: AbortSignal,
) {
  return probeFile(new Blob([new Uint8Array(bytes)]), videoLimits.resolve(overrides), signal);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the probe to fail");
}

/** Finds a box type's first occurrence in a file's bytes. */
function find(bytes: Uint8Array, type: string): number {
  const codes = Array.from(type, (char) => char.charCodeAt(0));
  for (let i = 4; i < bytes.length - 4; i += 1) {
    if (codes.every((code, j) => bytes[i + j] === code)) return i - 4;
  }
  throw new Error(`no ${type} box`);
}

describe("probing the generated fixtures", () => {
  it.each([
    ["landscape.mp4", "mp4", "avc1.", "mp4a.40.2"],
    ["landscape.webm", "webm", "vp09.", "opus"],
    ["landscape.mkv", "mkv", "avc1.", "mp4a.40.2"],
    ["fragmented.mp4", "mp4", "avc1.", "mp4a.40.2"],
  ])(
    "reads %s: its container, tracks, size, rate and length",
    async (name, container, video, audio) => {
      const probed = await probe(await fixture(name));
      expect(probed).toMatchObject({ container, tracks: 2 });
      expect(probed.video).toMatchObject({
        codedWidth: 1280,
        codedHeight: 720,
        displayWidth: 1280,
        displayHeight: 720,
        rotation: 0,
        frameRate: 30,
        packets: 60,
      });
      expect(probed.video.codec.startsWith(video)).toBe(true);
      expect(probed.audio).toEqual({ codec: audio, sampleRate: 48_000, channels: 2 });
      // Two seconds, plus at most an audio frame's padding.
      expect(probed.duration).toBeGreaterThanOrEqual(2_000_000);
      expect(probed.duration).toBeLessThan(2_100_000);
      expect(probed.indexSize).toBeGreaterThan(0);
      expect(probed.peakBitrate).toBeGreaterThan(0);
      expect(probed.maxPacketSize).toBeGreaterThan(0);
      expect(checkProbe(policy, probed)).toEqual([]);
    },
  );

  it("reads a QuickTime file's rotation, keeping the display size before it", async () => {
    const probed = await probe(await fixture("rotated.mov"));
    expect(probed.container).toBe("mov");
    expect(probed.video).toMatchObject({ displayWidth: 1280, displayHeight: 720, rotation: 90 });
  });

  it("reports where a source's time starts, at its first frame, and measures its length from there", async () => {
    // Timestamps from 1 s. Opus starts 7 ms before the first frame, for its
    // codec delay: pre-roll, not the source's start.
    const probed = await probe(await fixture("offset.webm"));
    expect(probed.start).toBe(1_000_000);
    expect((await probe(await fixture("landscape-vp8.webm"))).start).toBe(0);
    expect(probed.duration).toBeGreaterThan(190_000);
    expect(probed.duration).toBeLessThan(260_000);
    expect((await probe(await fixture("landscape.mp4"))).start).toBeLessThan(50_000);
  });

  it("reports no audio for a silent file, and one track", async () => {
    const probed = await probe(await fixture("silent.mp4"));
    expect(probed.audio).toBeNull();
    expect(probed.tracks).toBe(1);
  });

  it("never lets a header shorten a file below its packets", async () => {
    const bytes = await fixture("landscape.mp4");
    // mvhd, version 0: version and flags, two times, the timescale, then the duration.
    const mvhd = find(bytes, "mvhd");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const timescale = view.getUint32(mvhd + 20);
    view.setUint32(mvhd + 24, Math.round(timescale * 0.5));
    expect((await probe(bytes)).duration).toBeGreaterThanOrEqual(2_000_000);
  });
});

describe("the limits the probe applies itself", () => {
  it("checks the file's size first", async () => {
    const error = await rejection(probe(await fixture("landscape.mp4"), { maxFileSize: 1_000 }));
    expect(isVideoError(error, "FILE_TOO_LARGE")).toBe(true);
  });

  it.each(["landscape.mp4", "landscape.webm", "fragmented.mp4"])(
    "refuses %s's index over maxIndexSize before mediabunny reads it",
    async (name) => {
      const error = await rejection(probe(await fixture(name), { maxIndexSize: 100 }));
      expect(isVideoError(error, "INDEX_TOO_LARGE")).toBe(true);
    },
  );

  it("stops the packet walk once a track has more packets than the limits allow", async () => {
    // 100 ms at 120 frames per second allows 12 video packets; the file has 60.
    const error = await rejection(probe(await fixture("landscape.mp4"), { maxDuration: 100 }));
    expect(isVideoError(error, "FRAME_RATE_TOO_HIGH")).toBe(true);
    expect((error as { details?: unknown }).details).toMatchObject({ limit: "maxFrameRate" });
  });

  it("rejects a cancelled probe with ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(probe(await fixture("landscape.mp4"), {}, controller.signal));
    expect(isVideoError(error, "ABORTED")).toBe(true);
  });
});

describe("files the probe refuses", () => {
  it("refuses an unknown signature without reading further", async () => {
    const error = await rejection(probe(new TextEncoder().encode("GIF89a, not a video")));
    expect(isVideoError(error, "UNSUPPORTED_FORMAT")).toBe(true);
  });

  it("maps whatever mediabunny can't read to INVALID_VIDEO, never its own error", async () => {
    const bytes = await fixture("landscape.mp4");
    // Overwrite the sample tables inside moov, keeping its structure.
    const stbl = find(bytes, "stbl");
    bytes.fill(0xff, stbl + 8, stbl + 400);
    const error = await rejection(probe(bytes));
    expect(isVideoError(error)).toBe(true);
    expect(["INVALID_VIDEO", "UNSUPPORTED_CODEC", "UNSUPPORTED_FORMAT"]).toContain(
      (error as { code: string }).code,
    );
  });
});
