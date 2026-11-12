import { VideoError } from "../../core/errors/video-error.js";

/**
 * The reasons the front check gives in `details.reason` (ADR 0001). They name
 * what was wrong, never data from the file.
 *
 * @internal
 */
export type FrontCheckReason =
  | "signature"
  | "doc-type"
  | "truncated"
  | "box-size"
  | "element-size"
  | "too-many-elements"
  | "no-index"
  | "no-tracks"
  | "edit-list"
  | "encryption";

/** A malformed file: `INVALID_VIDEO`. */
export function malformed(container: string, reason: FrontCheckReason): VideoError {
  return new VideoError("INVALID_VIDEO", `The ${container} file is malformed: ${reason}.`, {
    details: { container, reason },
  });
}

/** A file the SDK refuses: `UNSUPPORTED_FORMAT`. */
export function refused(container: string, reason: FrontCheckReason): VideoError {
  return new VideoError("UNSUPPORTED_FORMAT", `The ${container} file can't be opened: ${reason}.`, {
    details: { container, reason },
  });
}
