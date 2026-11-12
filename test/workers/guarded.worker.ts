// The media worker's own handlers, in a worker where the network and new
// workers are guarded (ADR 0028). The guard is imported first, so it's in
// place before mediabunny is evaluated.

import { exposeWorker } from "@hussmartinez/sdk-core";
import type { MediaWorkerContract } from "../../src/adapters/media-worker/contract.js";
import { mediaWorkerHandlers } from "../../src/adapters/media-worker/handlers.js";
import { forbiddenCalls } from "./guard.js";

export interface GuardedContract extends MediaWorkerContract {
  readonly forbiddenCalls: { readonly input: undefined; readonly output: string[] };
  /** Calls each guarded API itself, to prove the guard is in place. */
  readonly tripGuard: { readonly input: undefined; readonly output: number };
}

exposeWorker<GuardedContract>({
  ...mediaWorkerHandlers(),
  forbiddenCalls: () => [...forbiddenCalls],
  tripGuard() {
    const attempts: (() => unknown)[] = [
      () => fetch("https://example.com"),
      () => new XMLHttpRequest(),
      () =>
        (globalThis as unknown as { importScripts: (url: string) => void }).importScripts("x.js"),
      () => new Worker("x.js"),
      () => new WebSocket("wss://example.com"),
      () =>
        new (globalThis as unknown as { WebTransport: new (url: string) => unknown }).WebTransport(
          "https://example.com",
        ),
      () => new EventSource("https://example.com"),
      () => URL.createObjectURL(new Blob()),
    ];
    let thrown = 0;
    for (const attempt of attempts) {
      try {
        attempt();
      } catch {
        thrown += 1;
      }
    }
    return thrown;
  },
});
