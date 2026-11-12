import type { VideoLimitName } from "../../core/errors/video-limits.js";
import type { VideoPlan } from "../../core/model/plan.js";
import type { VideoPeaks, VideoProbe } from "../../core/model/source.js";
import type { SchedulerCommand } from "../../core/playback/scheduler.js";

/**
 * A resolved file policy's limits, as plain data: a `FilePolicy` holds
 * functions, which can't cross the worker boundary, so the worker resolves
 * the same policy again from these.
 */
export type PolicyLimits = Readonly<
  Record<VideoLimitName, { readonly maximum: number; readonly warning: number }>
>;

/** A source the plan plays, as the playback worker needs it. */
export interface PlaybackSource {
  readonly id: string;
  readonly file: Blob;
  readonly probe: VideoProbe;
  /** The policy the source was opened under, for the front check before it's read. */
  readonly limits: PolicyLimits;
}

/**
 * The media worker's RPC contract (docs/adr/0002), shared by the page and the
 * worker. Probing, support and peaks keep no state between calls: the page
 * sends the file, a `Blob` that crosses the boundary by reference, with every
 * call. Playback keeps the canvas, the plan and the scheduler, in a worker of
 * its own per output (docs/adr/0006).
 */
export interface MediaWorkerContract {
  /** Checks a file and walks its packets, without decoding it (docs/adr/0001). */
  readonly probe: {
    readonly input: { readonly file: Blob; readonly limits: PolicyLimits };
    readonly output: VideoProbe;
  };
  /**
   * Checks that this browser can decode the tracks of a probed file, and
   * decodes its first video frame to prove it (docs/adr/0001). The front
   * check runs first, under the same limits as a probe, so mediabunny never
   * reads a file it hasn't bounded. It rejects with `UNSUPPORTED_CODEC`,
   * `UNSUPPORTED_ENVIRONMENT` or `DECODE_FAILED`.
   */
  readonly support: {
    readonly input: {
      readonly file: Blob;
      readonly limits: PolicyLimits;
      readonly probe: VideoProbe;
    };
    readonly output: undefined;
  };
  /**
   * Decodes a probed file's audio and builds its waveform peaks, or `null`
   * without audio (docs/adr/0002). The front check runs first, as for
   * `support`.
   */
  readonly peaks: {
    readonly input: {
      readonly file: Blob;
      readonly limits: PolicyLimits;
      readonly probe: VideoProbe;
    };
    readonly output: VideoPeaks | null;
  };
  /** Takes the canvas the page transferred, once (docs/adr/0002). */
  readonly attach: {
    readonly input: { readonly canvas: OffscreenCanvas };
    readonly output: undefined;
  };
  /** Sets the plan and its sources, and stops what's running until the next `control`. */
  readonly load: {
    readonly input: { readonly plan: VideoPlan; readonly sources: readonly PlaybackSource[] };
    readonly output: undefined;
  };
  /**
   * Plays from an anchor, shows a frame, pauses, or stops for a hidden page
   * (docs/adr/0006). Replies with the frames dropped since the plan was
   * loaded, and rejects with the failure that stopped playback, once. A
   * `show` replies once its frame is drawn, so its own failure rejects it.
   */
  readonly control: {
    readonly input: SchedulerCommand;
    readonly output: { readonly droppedFrames: number };
  };
}
