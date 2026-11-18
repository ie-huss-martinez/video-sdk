import type { VideoLimitName } from "../errors/video-limits.js";
import type { VideoPlan } from "../model/plan.js";
import type { VideoProgressOptions } from "./options.js";

/**
 * Options for one export.
 *
 * @public
 */
export interface VideoExportOptions extends VideoProgressOptions {
  /**
   * Called once for each limit the export reaches the warning of, such as
   * `maxFileSize` when the file grows past its warning size. The export goes
   * on; past the maximum it fails with the limit's code.
   */
  readonly onWarning?: (limit: VideoLimitName) => void;
}

/**
 * The container an export asks for. The codecs are chosen by what the
 * browser can encode (ADR 0001).
 *
 * @public
 */
export type VideoExportContainer = "mp4" | "webm";

/**
 * How much an export's encoder may spend on quality, which sets its bitrate
 * from the output's size and frame rate (ADR 0005).
 *
 * @public
 */
export type VideoExportQuality = "low" | "medium" | "high";

/**
 * One export: a plan over sources open in the same engine, and the file to
 * produce.
 *
 * @public
 */
export interface VideoExportJob {
  readonly plan: VideoPlan;
  /** Defaults to MP4 where the browser can encode it, and WebM otherwise. */
  readonly container?: VideoExportContainer;
  /** Defaults to `medium`. */
  readonly quality?: VideoExportQuality;
  /**
   * `"omit"` exports without sound: no sound track is written. For a
   * browser that can't encode sound, whose export of a plan with sound fails
   * with `UNSUPPORTED_CODEC` and `details.track: "audio"` (ADR 0008). Sound
   * is never left out otherwise. Defaults to `"include"`.
   */
  readonly audio?: "include" | "omit";
}

/**
 * What an export gives: the file, and what clamping did to its sound
 * (docs/adr/0008). The mix is clamped to full scale rather than limited or
 * normalised, which would change levels nobody asked to change, and this
 * says how much it was over, so an editor can say so. The same shape as
 * audio-sdk's export result, with the container and size.
 *
 * @public
 */
export interface VideoExportResult {
  /** The file. Its `type` is its container's media type: `video/mp4` or `video/webm`. */
  readonly blob: Blob;
  /** The container the browser could encode, which may differ from the one asked for. */
  readonly container: VideoExportContainer;
  /** The file's size, in bytes. */
  readonly size: number;
  /**
   * The mix's peak before clamping, in decibels relative to full scale:
   * above 0 means it clipped, by that much. `-Infinity` for silence, and for
   * a plan without sound.
   */
  readonly peakDb: number;
  /** How many sample frames had a sample over full scale, which was clamped. */
  readonly clippedFrames: number;
}

/**
 * The port for exporting: decode, compose and encode a plan into a file
 * (ADR 0001, ADR 0003, ADR 0005, ADR 0008). The SDK's own adapter does it in
 * its export worker; hosts can pass their own to the editor's `processor`
 * prop, and every implementation must pass the processor's contract tests.
 *
 * Failures reject with `VideoError`: `BUSY` while another export runs,
 * `UNSUPPORTED_CODEC` when the browser can't encode the container,
 * `ENCODE_FAILED` when encoding fails, and sdk-core's codes for cancellation
 * and worker failures. A clip whose source isn't open rejects with
 * `TypeError`.
 *
 * @public
 */
export interface VideoProcessor {
  /**
   * Exports a plan. The file holds exactly the plan's frames and audio, and
   * only the metadata the plan sets: nothing from a source is copied into it
   * (ADR 0005). A cancelled export returns no file. A file that grows past
   * the policy's `maxFileSize` fails with `FILE_TOO_LARGE`, as soon as it
   * does, and returns no file either. The sound is clamped to full scale,
   * and the result says by how much it was over.
   */
  export(job: VideoExportJob, options?: VideoExportOptions): Promise<VideoExportResult>;
  /** Releases the processor and its worker. Pending calls reject, and later calls throw. */
  destroy(): Promise<void>;
}
