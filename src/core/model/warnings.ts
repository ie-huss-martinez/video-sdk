import type { VideoLimitName } from "../errors/video-limits.js";

/**
 * A value at or above a limit's warning threshold, but within its maximum
 * (ADR 0004): what it was, and, for a file's own limits, which source it's
 * about. The same shape as audio-sdk's limit warning.
 *
 * @public
 */
export interface VideoLimitWarning {
  readonly type: "limit";
  readonly limit: VideoLimitName;
  /** The value, in the limit's unit. */
  readonly actual: number;
  /** The source it's about, for a file's limits; absent for the plan's and the output's. */
  readonly source?: string;
}

/**
 * Something the user should know about what's open, though it opened or
 * applied (ADR 0004). Show its text with `messages.warning(warning)`, from
 * `warnings.<limit>` for a limit, or `warnings.<type>` for the others.
 * The family's warnings share this shape: a `type`, and for a limit, the
 * limit and its value.
 *
 * @public
 */
export type VideoWarning = VideoLimitWarning | VideoAudioUndecodableWarning;

/**
 * A file whose sound this browser can't decode, which opened with its
 * picture and no sound (docs/adr/0008).
 *
 * @public
 */
export interface VideoAudioUndecodableWarning {
  readonly type: "audioUndecodable";
  /** The source it's about. */
  readonly source: string;
  /** The sound's codec, as a WebCodecs codec string, such as `"mp4a.40.2"`. */
  readonly codec: string;
}

/**
 * A limit's warning.
 *
 * @internal
 */
export function limitWarning(
  limit: VideoLimitName,
  actual: number,
  source?: string,
): VideoLimitWarning {
  return source === undefined
    ? { type: "limit", limit, actual }
    : { type: "limit", limit, actual, source };
}
