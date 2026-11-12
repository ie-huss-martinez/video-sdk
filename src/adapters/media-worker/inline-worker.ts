import MediaWorker from "../../workers/media.worker.ts?worker&inline";

/** Starts the inlined media worker, from its own lazy chunk. */
export function createInlineWorker(): Worker {
  return new MediaWorker({ name: "hm-video-media" });
}
