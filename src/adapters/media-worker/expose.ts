import { type ExposeWorkerOptions, exposeWorker } from "@hussmartinez/sdk-core";
import type { MediaWorkerContract } from "./contract.js";
import { mediaWorkerHandlers } from "./handlers.js";

/**
 * Answers the media worker's contract (docs/adr/0002). It does nothing on
 * import, and there's no heavy initialisation, so the worker announces
 * itself at once.
 */
export function exposeMediaWorker(options?: ExposeWorkerOptions): void {
  exposeWorker<MediaWorkerContract>(mediaWorkerHandlers(), options);
}
