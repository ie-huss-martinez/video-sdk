import { createErrorHelpers } from "@hussmartinez/sdk-core";
import { isVideoError, VideoError } from "./video-error.js";

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
 * A worker's own reason for not starting, when the worker client reports it
 * as the cause of its own: such as a build that left the inlined worker out
 * with the hm-self-hosted condition (sdk-core ADR 0060), which says so, and
 * that `assetsUrl` is needed. `undefined` otherwise.
 *
 * @internal
 */
export function startFailureOf(error: unknown): VideoError | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return isVideoError(cause, "WORKER_START_FAILED") ? cause : undefined;
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
