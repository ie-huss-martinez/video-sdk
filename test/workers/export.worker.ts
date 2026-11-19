// The export pipeline, exposed for tests (docs/adr/0005): exports with
// warnings as progress, and the ledgers of open frames and audio, so tests
// can prove everything is closed on every path.
import { exposeWorker } from "@hussmartinez/sdk-core";
import {
  type ExportOutcome,
  type ExportRequest,
  exportLedger,
  exportPlan,
} from "../../src/adapters/export-worker/export-plan.js";
import { audioDataLedger } from "../../src/adapters/mediabunny/audio-decoder.js";
import { videoFrameLedger } from "../../src/adapters/mediabunny/video-decoder.js";
import type { VideoLimitName } from "../../src/core/errors/video-limits.js";
import { laggingAudioDecoderClass } from "./lagging-decoder.js";

/** An export, and whether its sources' audio decoder stopped: nothing back, and a flush that never settles. */
export type ExportTestRequest = ExportRequest & { readonly stallAudio?: boolean };

export interface ExportTestContract {
  readonly export: {
    readonly input: ExportTestRequest;
    readonly output: ExportOutcome;
    readonly progress: number | { readonly warning: VideoLimitName };
  };
  readonly ledger: {
    readonly input: undefined;
    readonly output: { readonly frames: number; readonly decoded: number; readonly audio: number };
  };
}

exposeWorker<ExportTestContract>({
  async export({ stallAudio, ...request }, { signal, progress }) {
    const RealDecoder = globalThis.AudioDecoder;
    if (stallAudio) {
      // Only the sources' Opus: the probe of an AAC encoder's priming decodes too.
      globalThis.AudioDecoder = laggingAudioDecoderClass(0, true, "opus");
    }
    try {
      return await exportPlan(request, progress, signal, (limit) => progress({ warning: limit }));
    } finally {
      globalThis.AudioDecoder = RealDecoder;
    }
  },
  ledger: () => ({
    frames: exportLedger.frames,
    decoded: videoFrameLedger.open,
    audio: audioDataLedger.open,
  }),
});
