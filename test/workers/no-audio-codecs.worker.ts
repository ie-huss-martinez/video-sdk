// The media worker's handlers and the export pipeline, in a worker with no
// AudioDecoder or AudioEncoder (docs/adr/0008).
import "./without-audio-codecs.js";
import { exposeWorker } from "@hussmartinez/sdk-core";
import type { ExportWorkerContract } from "../../src/adapters/export-worker/contract.js";
import { exportPlan } from "../../src/adapters/export-worker/export-plan.js";
import type { MediaWorkerContract } from "../../src/adapters/media-worker/contract.js";
import { mediaWorkerHandlers } from "../../src/adapters/media-worker/handlers.js";
import { PACKAGE_VERSION } from "../../src/version.js";

export type NoAudioCodecsContract = MediaWorkerContract & ExportWorkerContract;

exposeWorker<NoAudioCodecsContract>(
  {
    ...mediaWorkerHandlers(),
    export: (request, { signal, progress }) =>
      exportPlan(request, progress, signal, (limit) => progress({ warning: limit })),
  },
  // The SDK's clients refuse a worker that doesn't announce their version.
  { packageVersion: PACKAGE_VERSION },
);
