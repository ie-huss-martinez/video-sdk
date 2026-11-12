import type { VideoLimitName } from "../../core/errors/video-limits.js";
import type { VideoProbe } from "../../core/model/source.js";

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
}
