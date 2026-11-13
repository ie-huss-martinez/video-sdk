import { createErrorHelpers } from "@hussmartinez/sdk-core";
import { VideoError } from "./video-error.js";

/**
 * The family's error helpers for `VideoError` (sdk-core ADR 0034): failures
 * that aren't an `SdkError` become `UNKNOWN`.
 */
const helpers = /* @__PURE__ */ createErrorHelpers(VideoError, {
  fallbackCode: "UNKNOWN",
  fallbackMessage: "Video processing failed.",
});

/**
 * Makes any failure a `VideoError`, as every port promises: a `VideoError`
 * as it is, another `SdkError` with its code, details and message, and
 * anything else as `UNKNOWN`. The original is kept as `cause`.
 *
 * @internal
 */
export function asVideoError(reason: unknown, message?: string): VideoError {
  return helpers.adapt(reason, message);
}

/**
 * The error an aborted call rejects with (sdk-core ADR 0018, ADR 0020): an
 * `SdkError` reason adapted as by {@link asVideoError}, so a file policy's
 * `PROCESSING_TIME_EXCEEDED` keeps its code; `TIMEOUT` for a timeout; and
 * `ABORTED` otherwise. The reason is kept as `cause`.
 *
 * @internal
 */
export function abortError(signal: AbortSignal): VideoError {
  return helpers.abortError(signal);
}

/**
 * Throws {@link abortError} if the signal has aborted.
 *
 * @internal
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  helpers.throwIfAborted(signal);
}
