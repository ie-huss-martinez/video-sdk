import ExportWorker from "../../workers/export.worker.ts?worker&inline";

/** Starts the inlined export worker, from its own lazy chunk. */
export function createInlineExportWorker(): Worker {
  return new ExportWorker({ name: "hm-video-export" });
}
