import { isSdkError, type SdkCoreErrorCode, SdkError } from "@hussmartinez/sdk-core";

/**
 * Error codes of `@hussmartinez/video-sdk`: sdk-core's own codes, such as
 * `ABORTED`, `WORKER_CRASHED` and `FILE_TOO_LARGE`, plus the video SDK's
 * (ADR 0001, ADR 0004). They never change meaning once released.
 *
 * - `INVALID_VIDEO`: the file is malformed, its headers disagree with its
 *   packets, or it decodes to more than its probe allows.
 * - `UNSUPPORTED_FORMAT`: the container isn't recognised, it uses an edit
 *   list or encryption the SDK refuses, or it has no video track.
 *   `details.reason` says which.
 * - `UNSUPPORTED_CODEC`: the browser can't decode a track's codec, or can't
 *   encode any container and codecs for an export. `details.codec` names it.
 * - `DECODE_FAILED`: the browser failed to decode a probed, supported file.
 *   `details.codec` names the codec, and `details.reason` is `"stalled"`
 *   when its decoder stopped producing frames.
 * - `ENCODE_FAILED`: the browser failed to encode during an export.
 *   `details.codec` names the codec.
 * - `INVALID_COMMAND`: an edit command doesn't apply to the clip plan, such
 *   as a range outside its source, a clip off the frame grid or an unknown
 *   clip key.
 * - `BUSY`: an export was requested while another is running.
 * - `FRAME_TOO_LARGE`: a video track, a decoded frame or the output exceeds
 *   the `maxFramePixels` limit.
 * - `FRAME_RATE_TOO_HIGH`: a video track or the output exceeds the
 *   `maxFrameRate` limit.
 * - `DURATION_TOO_LONG`: a file or the plan exceeds the `maxDuration` limit.
 * - `BITRATE_TOO_HIGH`: a file's peak bitrate exceeds the `maxBitrate` limit.
 * - `PACKET_TOO_LARGE`: a packet exceeds the `maxPacketSize` limit.
 * - `TOO_MANY_TRACKS`: a file exceeds the `maxTracks` limit.
 * - `INDEX_TOO_LARGE`: a file's index exceeds the `maxIndexSize` limit.
 * - `TOO_MANY_CHANNELS`: an audio track or the output exceeds the
 *   `maxChannels` limit.
 * - `SAMPLE_RATE_TOO_HIGH`: an audio track or the output exceeds the
 *   `maxSampleRate` limit.
 * - `SESSION_TOO_LARGE`: what the session keeps besides its decoders exceeds
 *   the `maxSessionSize` limit.
 * - `TOO_MANY_CLIPS`: the clip plan exceeds the `maxClips` limit.
 *
 * Limit codes carry `details` with the `limit`, its `maximum`, the `actual`
 * value and the `unit`. Other codes' `details` name the container, codec or
 * reason involved, never data from the file.
 *
 * @public
 */
export type VideoErrorCode =
  | SdkCoreErrorCode
  | "INVALID_VIDEO"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_CODEC"
  | "DECODE_FAILED"
  | "ENCODE_FAILED"
  | "INVALID_COMMAND"
  | "BUSY"
  | "FRAME_TOO_LARGE"
  | "FRAME_RATE_TOO_HIGH"
  | "DURATION_TOO_LONG"
  | "BITRATE_TOO_HIGH"
  | "PACKET_TOO_LARGE"
  | "TOO_MANY_TRACKS"
  | "INDEX_TOO_LARGE"
  | "TOO_MANY_CHANNELS"
  | "SAMPLE_RATE_TOO_HIGH"
  | "SESSION_TOO_LARGE"
  | "TOO_MANY_CLIPS";

/**
 * The error `@hussmartinez/video-sdk` throws and rejects with, with a stable
 * `code`, structured `details` and the underlying error as `cause`. Show
 * users the text for its code from {@link videoMessages}, never its
 * `message`, which is for developers and may contain text from the file.
 *
 * @example
 * ```ts
 * try {
 *   await session.open(file);
 * } catch (error) {
 *   if (isVideoError(error, "UNSUPPORTED_CODEC")) {
 *     suggestAnotherBrowser();
 *   } else {
 *     show(messages.error(error));
 *   }
 * }
 * ```
 *
 * @public
 */
export class VideoError extends SdkError<VideoErrorCode> {
  /** Always `"VideoError"`, which survives minification and worker boundaries. */
  override readonly name = "VideoError";
}

/**
 * Checks whether a value is a {@link VideoError}, optionally with a given
 * code.
 *
 * Unlike `instanceof`, it recognises errors from another copy of this
 * package or another realm, and errors rebuilt after crossing a worker
 * boundary.
 *
 * @param value - Any thrown value.
 * @param code - When given, the error must also have this code.
 * @public
 */
export function isVideoError<Code extends VideoErrorCode = VideoErrorCode>(
  value: unknown,
  code?: Code,
): value is VideoError & { readonly code: Code } {
  return isSdkError(value, code) && value.name === "VideoError";
}
