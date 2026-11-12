import { deserializeError, isSdkError, SdkError, serializeError } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { isVideoError, VideoError } from "./video-error.js";

describe("VideoError", () => {
  it("carries a code, details and cause, as an SdkError", () => {
    const cause = new DOMException("Decoding error.", "EncodingError");
    const error = new VideoError("DECODE_FAILED", "The browser couldn't decode the track.", {
      details: { codec: "hvc1" },
      cause,
    });
    expect(error).toBeInstanceOf(SdkError);
    expect(error).toMatchObject({
      name: "VideoError",
      code: "DECODE_FAILED",
      details: { codec: "hvc1" },
      cause,
    });
    expect(isSdkError(error, "DECODE_FAILED")).toBe(true);
  });

  it("keeps its class, code and details across a worker boundary", () => {
    const original = new VideoError("FRAME_TOO_LARGE", "Too many pixels per frame.", {
      details: {
        limit: "maxFramePixels",
        maximum: 3840 * 2160,
        actual: 16_384 * 16_384,
        unit: "pixels",
      },
    });
    // What a worker posts, cloned as postMessage would.
    const received = structuredClone(serializeError(original));
    const rebuilt = deserializeError(received, { errorClasses: { VideoError } });
    expect(rebuilt).toBeInstanceOf(VideoError);
    expect(isVideoError(rebuilt, "FRAME_TOO_LARGE")).toBe(true);
    expect(rebuilt.details).toEqual(original.details);
  });
});

describe("isVideoError", () => {
  it("recognises a VideoError, and checks its code when given one", () => {
    const error = new VideoError("INVALID_VIDEO", "Truncated sample table.");
    expect(isVideoError(error)).toBe(true);
    expect(isVideoError(error, "INVALID_VIDEO")).toBe(true);
    expect(isVideoError(error, "UNSUPPORTED_FORMAT")).toBe(false);
  });

  it("rejects other SDK errors and plain values", () => {
    expect(isVideoError(new SdkError("ABORTED", "Stopped."))).toBe(false);
    expect(isVideoError(new Error("INVALID_VIDEO"))).toBe(false);
    expect(isVideoError({ name: "VideoError", code: "INVALID_VIDEO", message: "forged" })).toBe(
      false,
    );
    expect(isVideoError(undefined)).toBe(false);
  });
});
