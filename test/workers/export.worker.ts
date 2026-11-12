// The export pipeline, exposed for tests (docs/adr/0005): exports with
// warnings as progress, and the ledgers of open frames and audio, so tests
// can prove everything is closed on every path.
import { exposeWorker } from "@hussmartinez/sdk-core";
import {
  type ExportRequest,
  exportLedger,
  exportPlan,
} from "../../src/adapters/export-worker/export-plan.js";
import { audioDataLedger } from "../../src/adapters/mediabunny/audio-decoder.js";
import { videoFrameLedger } from "../../src/adapters/mediabunny/video-decoder.js";
import type { VideoLimitName } from "../../src/core/errors/video-limits.js";

export interface ExportTestContract {
  readonly export: {
    readonly input: ExportRequest;
    readonly output: Blob;
    readonly progress: number | { readonly warning: VideoLimitName };
  };
  readonly ledger: {
    readonly input: undefined;
    readonly output: { readonly frames: number; readonly decoded: number; readonly audio: number };
  };
}

exposeWorker<ExportTestContract>({
  export: (request, { signal, progress }) =>
    exportPlan(request, progress, signal, (limit) => progress({ warning: limit })),
  ledger: () => ({
    frames: exportLedger.frames,
    decoded: videoFrameLedger.open,
    audio: audioDataLedger.open,
  }),
});
