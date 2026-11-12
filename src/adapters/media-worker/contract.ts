import type { VideoLimitName } from "../../core/errors/video-limits.js";
import type { VideoPeaks, VideoProbe } from "../../core/model/source.js";

/**
 * A resolved file policy's limits, as plain data: a `FilePolicy` holds
 * functions, which can't cross the worker boundary, so the worker resolves
 * the same policy again from these.
 */
export type PolicyLimits = Readonly<
  Record<VideoLimitName, { readonly maximum: number; readonly warning: number }>
>;

/**
 * The media worker's RPC contract (docs/adr/0002), shared by the page and the
 * worker. The worker keeps no state between calls: the page sends the file,
 * a `Blob` that crosses the boundary by reference, with every call.
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
}
