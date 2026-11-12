import type { VideoProbe, VideoSourceInfo } from "../model/source.js";
import type { VideoProbeOptions } from "./options.js";

/**
 * The port for reading video files: check and probe a file without decoding
 * it, and open probed files as sources for playback and export (ADR 0001,
 * ADR 0002, ADR 0008). The SDK's own adapter does this in its media worker;
 * hosts can pass their own to the editor's `engine` prop, and every
 * implementation must pass the engine's contract tests. Thumbnails and
 * waveform peaks join the port with the pull requests that build them.
 *
 * The engine applies only the limits that must hold before anything reads
 * the file's structure: `maxFileSize`, `maxIndexSize`, and the packet walk's
 * caps (ADR 0001). The session checks the probe against the rest with
 * `checkProbe`, between `probe` and `open` (ADR 0004).
 *
 * Failures reject with `VideoError`: `UNSUPPORTED_FORMAT` for a container
 * the engine doesn't recognise or refuses, `INVALID_VIDEO` for a malformed
 * file, `UNSUPPORTED_CODEC` for a track the browser can't decode, and
 * sdk-core's codes for cancellation and worker failures.
 *
 * @public
 */
export interface VideoEngine {
  /**
   * Checks a file and walks its packets, without decoding it. It reads the
   * file through the `Blob`, never all at once. The probe's duration is the
   * larger of what the header claims and what the walk found. A file over
   * `maxFileSize` or `maxIndexSize` rejects with that limit's code, and a
   * track with more packets than the policy's caps allow rejects with
   * `FRAME_RATE_TOO_HIGH` or `DURATION_TOO_LONG`.
   */
  probe(file: Blob, options?: VideoProbeOptions): Promise<VideoProbe>;
  /**
   * Opens a probed file as the source `id`, which playback and export can
   * then read. Rejects with `TypeError` if `id` is already open.
   *
   * A probe this engine made is trusted for the `Blob` it was made from, and
   * frozen so that it can't be changed. Any other probe, such as one copied
   * or restored from a saved session, or a probe of another file, makes the
   * engine probe the file again, under `filePolicy` as `probe` does, and
   * rejects with `INVALID_VIDEO` unless every field matches.
   *
   * A file opens only if this browser can decode the tracks the SDK uses:
   * otherwise `open` rejects with `UNSUPPORTED_CODEC`, naming the codec and
   * the track in `details`, or with `UNSUPPORTED_ENVIRONMENT` without
   * WebCodecs. That includes the audio track: a file whose audio this
   * browser can't decode is refused, never opened silent, so an export can't
   * drop its sound without saying so.
   */
  open(
    id: string,
    file: Blob,
    probe: VideoProbe,
    options?: VideoProbeOptions,
  ): Promise<VideoSourceInfo>;
  /** Closes a source once nothing refers to it. Closing an unknown id does nothing. */
  close(id: string): Promise<void>;
  /** Releases the engine and its worker. Pending calls reject, and later calls throw. */
  destroy(): Promise<void>;
}
