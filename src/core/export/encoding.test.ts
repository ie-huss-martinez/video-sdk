import { describe, expect, it } from "vitest";
import type { VideoPlanOutput } from "../model/plan.js";
import {
  audioBitrate,
  exportCandidates,
  exportSampleRate,
  h264Codec,
  keyFrameInterval,
  videoBitrate,
  vp9Codec,
} from "./encoding.js";

const output = (width: number, height: number, fps = 30): VideoPlanOutput => ({
  width,
  height,
  frameRate: { num: fps, den: 1 },
  sampleRate: 44_100,
  channels: 2,
});

describe("an export's encoding", () => {
  it("picks the lowest H.264 level that fits the size and frame rate", () => {
    expect(h264Codec(output(640, 360))).toBe("avc1.64001e");
    expect(h264Codec(output(1280, 720))).toBe("avc1.64001f");
    expect(h264Codec(output(1920, 1080))).toBe("avc1.640028");
    expect(h264Codec(output(1920, 1080, 60))).toBe("avc1.64002a");
    expect(h264Codec(output(3840, 2160))).toBe("avc1.640033");
    expect(h264Codec(output(3840, 2160, 60))).toBe("avc1.640034");
  });

  it("picks the lowest VP9 level that fits", () => {
    expect(vp9Codec(output(1920, 1080))).toBe("vp09.00.40.08");
    expect(vp9Codec(output(3840, 2160))).toBe("vp09.00.50.08");
  });

  it("tries MP4 with H.264 and AAC first, then Opus, then WebM, and keeps a container asked for", () => {
    const all = exportCandidates(output(1280, 720));
    expect(all.map((c) => `${c.container}:${c.video.muxer}+${c.audio.muxer}`)).toEqual([
      "mp4:avc+aac",
      "mp4:avc+opus",
      "webm:vp9+opus",
      "webm:vp8+opus",
    ]);
    expect(exportCandidates(output(1280, 720), "webm").map((c) => c.video.muxer)).toEqual([
      "vp9",
      "vp8",
    ]);
  });

  it("sets bitrates from the quality, and encodes Opus at 48 kHz", () => {
    expect(videoBitrate(output(1920, 1080), "medium")).toBe(6_220_800);
    expect(videoBitrate(output(1920, 1080), "high")).toBe(12_441_600);
    expect(audioBitrate(output(1920, 1080), "medium")).toBe(128_000);
    const [aac, opus] = exportCandidates(output(1280, 720));
    expect(aac && exportSampleRate(output(1280, 720), aac)).toBe(44_100);
    expect(opus && exportSampleRate(output(1280, 720), opus)).toBe(48_000);
    expect(keyFrameInterval(output(1280, 720))).toBe(60);
  });
});
