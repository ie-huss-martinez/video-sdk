import type { VideoLimitName } from "../../core/errors/video-limits.js";
import type { ExportRequest } from "./export-plan.js";

/**
 * The export worker's RPC contract (docs/adr/0002): one export at a time, with
 * progress as the fraction of output frames encoded. The worker keeps no
 * state between calls.
 */
export interface ExportWorkerContract {
  readonly export: {
    readonly input: ExportRequest;
    readonly output: Blob;
    /** The fraction of frames encoded, or a limit whose warning the export reached. */
    readonly progress: number | { readonly warning: VideoLimitName };
  };
}
