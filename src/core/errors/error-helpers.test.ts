import { SdkError } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { abortError, asVideoError, throwIfAborted } from "./error-helpers.js";
import { isVideoError, VideoError } from "./video-error.js";

describe("asVideoError", () => {
  it("keeps a VideoError, adapts another SdkError's code, and makes anything else UNKNOWN", () => {
    const own = new VideoError("BUSY", "Busy.");
    expect(asVideoError(own)).toBe(own);
    const crashed = asVideoError(new SdkError("WORKER_CRASHED", "Gone.", { details: { id: 1 } }));
    expect(isVideoError(crashed, "WORKER_CRASHED")).toBe(true);
    expect(crashed.details).toEqual({ id: 1 });
    const other = new TypeError("bad");
    expect(asVideoError(other)).toMatchObject({ code: "UNKNOWN", cause: other });
  });
});

describe("abortError", () => {
  const abortedWith = (reason?: unknown) => {
    const controller = new AbortController();
    controller.abort(reason);
    return controller.signal;
  };

  it("keeps a file policy's code given as the reason", () => {
    const reason = new SdkError("PROCESSING_TIME_EXCEEDED", "Too slow.");
    expect(isVideoError(abortError(abortedWith(reason)), "PROCESSING_TIME_EXCEEDED")).toBe(true);
  });

  it("maps a timeout to TIMEOUT and anything else to ABORTED", () => {
    expect(abortError(AbortSignal.abort(new DOMException("late", "TimeoutError"))).code).toBe(
      "TIMEOUT",
    );
    expect(abortError(abortedWith()).code).toBe("ABORTED");
  });

  it("throws only once the signal has aborted", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    expect(() => throwIfAborted(abortedWith())).toThrow(VideoError);
  });
});
