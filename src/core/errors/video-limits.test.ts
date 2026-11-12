import { checkFile, coreLimits } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { isVideoError } from "./video-error.js";
import { videoLimitDefinitions, videoLimits } from "./video-limits.js";

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

const HOUR = 60 * 60 * 1000;

describe("videoLimits", () => {
  it("keeps every core limit, with its code and unit", () => {
    for (const [name, definition] of Object.entries(coreLimits)) {
      expect(videoLimitDefinitions).toHaveProperty(name);
      const video = videoLimitDefinitions[name as keyof typeof coreLimits];
      expect(video.code, name).toBe(definition.code);
      expect(video.unit, name).toBe(definition.unit);
    }
  });

  it("names the frame limit maxFramePixels, FRAME_TOO_LARGE, in pixels, not maxImagePixels", () => {
    expect(videoLimitDefinitions.maxFramePixels).toMatchObject({
      code: "FRAME_TOO_LARGE",
      unit: "pixels",
    });
    expect(videoLimitDefinitions).not.toHaveProperty("maxImagePixels");
  });

  it("shares audio-sdk's names and codes for the limits both SDKs have", () => {
    expect(videoLimitDefinitions).toMatchObject({
      maxDuration: { code: "DURATION_TOO_LONG", unit: "milliseconds" },
      maxChannels: { code: "TOO_MANY_CHANNELS", unit: "count" },
      maxSampleRate: { code: "SAMPLE_RATE_TOO_HIGH" },
      maxSessionSize: { code: "SESSION_TOO_LARGE", unit: "bytes" },
      maxClips: { code: "TOO_MANY_CLIPS", unit: "count" },
    });
  });

  it("has the video defaults of ADR 0004", () => {
    const infinity = Number.POSITIVE_INFINITY;
    expect(videoLimits.resolve().limits).toEqual({
      maxFileSize: { maximum: 4_000_000_000, warning: 1_000_000_000 },
      maxFiles: { maximum: 20, warning: infinity },
      maxDecodedSize: { maximum: 1_000_000_000, warning: 400_000_000 },
      maxProcessingTime: { maximum: 120_000, warning: infinity },
      maxFramePixels: { maximum: 8_294_400, warning: 3_686_400 },
      maxFrameRate: { maximum: 120, warning: infinity },
      maxDuration: { maximum: 3 * HOUR, warning: HOUR },
      maxBitrate: { maximum: 200_000_000, warning: infinity },
      maxPacketSize: { maximum: 32_000_000, warning: infinity },
      maxTracks: { maximum: 16, warning: infinity },
      maxIndexSize: { maximum: 64_000_000, warning: infinity },
      maxChannels: { maximum: 8, warning: infinity },
      maxSampleRate: { maximum: 192_000, warning: infinity },
      maxSessionSize: { maximum: 512_000_000, warning: 256_000_000 },
      maxClips: { maximum: 2_000, warning: infinity },
    });
  });

  it("throws a VideoError naming the limit, and warns from the threshold", () => {
    const policy = videoLimits.resolve();
    expect(policy.check("maxFramePixels", 1920 * 1080)).toBeUndefined();
    expect(policy.check("maxFramePixels", 2560 * 1440)).toBe("warning");
    expect(policy.check("maxFramePixels", 3840 * 2160)).toBe("warning");

    // A frame of 16,384 × 16,384, which a small file can declare.
    const thrown = thrownBy(() => policy.check("maxFramePixels", 16_384 * 16_384));
    expect(isVideoError(thrown, "FRAME_TOO_LARGE")).toBe(true);
    expect((thrown as { details?: unknown }).details).toEqual({
      limit: "maxFramePixels",
      maximum: 8_294_400,
      actual: 268_435_456,
      unit: "pixels",
    });
  });

  it.each([
    ["maxFrameRate", 121, "FRAME_RATE_TOO_HIGH"],
    ["maxDuration", 3 * HOUR + 1, "DURATION_TOO_LONG"],
    ["maxBitrate", 200_000_001, "BITRATE_TOO_HIGH"],
    ["maxPacketSize", 32_000_001, "PACKET_TOO_LARGE"],
    ["maxTracks", 17, "TOO_MANY_TRACKS"],
    ["maxIndexSize", 64_000_001, "INDEX_TOO_LARGE"],
    ["maxChannels", 9, "TOO_MANY_CHANNELS"],
    ["maxSampleRate", 192_001, "SAMPLE_RATE_TOO_HIGH"],
    ["maxSessionSize", 512_000_001, "SESSION_TOO_LARGE"],
    ["maxClips", 2_001, "TOO_MANY_CLIPS"],
  ] as const)("throws %s violations with their own code", (limit, actual, code) => {
    const policy = videoLimits.resolve();
    expect(
      isVideoError(
        thrownBy(() => policy.check(limit, actual)),
        code,
      ),
    ).toBe(true);
  });

  it("throws core limit violations as VideoError too", () => {
    const policy = videoLimits.resolve({ maxFileSize: 10 });
    const file = new Blob([new Uint8Array(11)]);
    expect(() => checkFile(policy, file)).toThrow(
      expect.objectContaining({ name: "VideoError", code: "FILE_TOO_LARGE" }),
    );
    expect(
      isVideoError(
        thrownBy(() => videoLimits.resolve().check("maxDecodedSize", 1_000_000_001)),
        "DECODED_SIZE_TOO_LARGE",
      ),
    ).toBe(true);
  });

  it("applies a host's settings, and rejects unknown names and invalid values", () => {
    const policy = videoLimits.resolve({
      maxFramePixels: 7680 * 4320,
      maxDecodedSize: { maximum: 4e9, warning: 1.5e9 },
    });
    expect(policy.limits.maxFramePixels).toEqual({ maximum: 33_177_600, warning: 3_686_400 });
    expect(policy.limits.maxDecodedSize).toEqual({ maximum: 4e9, warning: 1.5e9 });

    // A typo, or another SDK's name for a similar limit, must not silently
    // leave the default in place (ADR 0020).
    expect(() => videoLimits.resolve({ maxImagePixels: 10 } as never)).toThrow(TypeError);
    expect(() => videoLimits.resolve({ maxPixels: 10 } as never)).toThrow(TypeError);
    expect(() => videoLimits.resolve({ maxTracks: 0 })).toThrow(RangeError);
    expect(() => videoLimits.resolve({ maxClips: { maximum: 10, warn: 5 } as never })).toThrow(
      TypeError,
    );
  });
});
