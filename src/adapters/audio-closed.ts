import { VideoError } from "../core/errors/video-error.js";

/**
 * What the audio player's `start` rejects with when `close` overtakes it,
 * as when the output is destroyed: a cancelled start, not a failure.
 *
 * @internal
 */
export function audioClosedError(): VideoError {
  return new VideoError("ABORTED", "The audio player was closed before it started.");
}
