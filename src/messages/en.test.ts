import { createMessages } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { VideoError, type VideoErrorCode } from "../core/errors/video-error.js";
import { videoLimitDefinitions, videoLimits } from "../core/errors/video-limits.js";
import { videoMessages } from "./en.js";

// Listing every code here makes the type checker fail when a code is added
// to VideoErrorCode without being listed, and the test fail when its text is
// missing from the catalogue.
const ALL_CODES: Record<VideoErrorCode, true> = {
  UNKNOWN: true,
  ABORTED: true,
  TIMEOUT: true,
  WORKER_START_FAILED: true,
  WORKER_PROTOCOL_MISMATCH: true,
  WORKER_CRASHED: true,
  WORKER_TERMINATED: true,
  WORKER_METHOD_NOT_FOUND: true,
  WORKER_DATA_NOT_CLONEABLE: true,
  UNSUPPORTED_ENVIRONMENT: true,
  FILE_TOO_LARGE: true,
  TOO_MANY_FILES: true,
  DECODED_SIZE_TOO_LARGE: true,
  PROCESSING_TIME_EXCEEDED: true,
  INVALID_VIDEO: true,
  UNSUPPORTED_FORMAT: true,
  UNSUPPORTED_CODEC: true,
  DECODE_FAILED: true,
  ENCODE_FAILED: true,
  INVALID_COMMAND: true,
  BUSY: true,
  FRAME_TOO_LARGE: true,
  FRAME_RATE_TOO_HIGH: true,
  DURATION_TOO_LONG: true,
  BITRATE_TOO_HIGH: true,
  PACKET_TOO_LARGE: true,
  TOO_MANY_TRACKS: true,
  INDEX_TOO_LARGE: true,
  TOO_MANY_CHANNELS: true,
  SAMPLE_RATE_TOO_HIGH: true,
  SESSION_TOO_LARGE: true,
  TOO_MANY_CLIPS: true,
};

function violation(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the limit to be exceeded");
}

describe("videoMessages", () => {
  it("has text for every VideoError code and every limit's warning", () => {
    for (const code of Object.keys(ALL_CODES)) {
      expect(videoMessages, code).toHaveProperty(`errors.${code}`);
    }
    for (const limit of Object.keys(videoLimitDefinitions)) {
      expect(videoMessages, limit).toHaveProperty(`warnings.${limit}`);
    }
  });

  it("is a valid catalogue", () => {
    // createMessages throws on a malformed message in the SDK's own catalogue.
    expect(() => createMessages(videoMessages)).not.toThrow();
  });

  it("describes a limit violation with its details, never its message", () => {
    const messages = createMessages(videoMessages);
    const policy = videoLimits.resolve();
    expect(messages.error(violation(() => policy.check("maxFrameRate", 240)))).toBe(
      "This video has 240 frames per second, which is more than the limit of 120.",
    );
    expect(messages.error(violation(() => policy.check("maxTracks", 40)))).toBe(
      "This file has 40 tracks, which is over the 16-track limit.",
    );
    expect(messages.error(violation(() => policy.check("maxSampleRate", 384_000)))).toBe(
      "This video's audio sample rate is 384,000 Hz, which is over the 192,000 Hz limit.",
    );
    expect(messages.error(violation(() => policy.check("maxSessionSize", 600_000_000)))).toBe(
      "The open videos' previews would use 600 MB of memory, which is over the 512 MB limit. Remove a video, and try again.",
    );
    expect(messages.error(violation(() => policy.check("maxDuration", 4 * 60 * 60 * 1_000)))).toBe(
      "This video is longer than the 3 hr the editor can open.",
    );
    expect(messages.error(violation(() => policy.check("maxFramePixels", 16_384 ** 2)))).toBe(
      "This video's picture is larger than the editor can handle. Try a smaller version of it.",
    );
    expect(messages.error(new VideoError("INVALID_VIDEO", "<script>from the file</script>"))).toBe(
      "This file isn't a valid video, or it's too damaged to open.",
    );
  });

  it("formats numbers and plurals for the locale", () => {
    const en = createMessages(videoMessages);
    expect(en.t("warnings.maxClips", { actual: 1 })).toBe(
      "This video has 1 clip. Many clips may be slow to play and save.",
    );
    expect(en.t("errors.TOO_MANY_CLIPS", { maximum: 2_000 })).toBe(
      "A video can have up to 2,000 clips. Join or delete clips, and try again.",
    );
    expect(en.t("warnings.maxSessionSize", { actual: 300_000_000 })).toBe(
      "The open videos' previews use 300 MB of memory. Removing videos frees memory.",
    );
    const de = createMessages(videoMessages, { locale: "de" });
    expect(de.t("warnings.maxTracks", { actual: 1_200 })).toBe(
      "This file has 1.200 tracks. Only one video and one audio track are used.",
    );
  });
});
