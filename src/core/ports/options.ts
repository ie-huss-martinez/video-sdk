import type { VideoFilePolicy } from "../errors/video-limits.js";

/**
 * Options every port call accepts.
 *
 * @public
 */
export interface VideoCallOptions {
  /**
   * Cancels the call. It then rejects with a `VideoError` whose code is
   * `ABORTED`, `TIMEOUT`, or the code of an `SdkError` given as the abort
   * reason, such as `PROCESSING_TIME_EXCEEDED`.
   */
  readonly signal?: AbortSignal;
}

/**
 * Options for probing a file.
 *
 * @public
 */
export interface VideoProbeOptions extends VideoCallOptions {
  /**
   * The limits the probe applies itself, before mediabunny reads the file:
   * `maxFileSize`, `maxIndexSize`, and the packet walk's caps from
   * `maxDuration` and `maxFrameRate` (ADR 0001, ADR 0004). The defaults of
   * `videoLimits` when omitted.
   */
  readonly filePolicy?: VideoFilePolicy;
}

/**
 * Options for long calls, which report how far they've got.
 *
 * @public
 */
export interface VideoProgressOptions extends VideoCallOptions {
  /**
   * Called with the fraction done, from 0 to 1. It only moves forward, and
   * it's called with 1 before the call resolves.
   */
  readonly onProgress?: (fraction: number) => void;
}
