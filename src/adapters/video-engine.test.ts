import type { WorkerLike } from "@hussmartinez/sdk-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVideoError } from "../core/errors/video-error.js";
import { createEngine, engineInternals } from "./video-engine.js";

// The engine's worker options, without a real worker: one that never says
// it's ready, as a worker still loading on a busy machine.

/** A worker that never sends its ready message. */
function silentWorker(): WorkerLike {
  return {
    postMessage() {},
    terminate() {},
    addEventListener() {},
    removeEventListener() {},
  } as unknown as WorkerLike;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the engine's start timeout", () => {
  it("fails a worker that doesn't start in time with WORKER_START_FAILED, and passes the time on", async () => {
    vi.useFakeTimers();
    const engine = createEngine({ loadWorker: async () => silentWorker, startTimeout: 30_000 });
    expect(engineInternals(engine)?.startTimeout).toBe(30_000);
    const probing = engine.probe(new Blob([new Uint8Array(16)])).catch((error: unknown) => error);
    // sdk-core's default of 10 s has passed, and the engine's own hasn't.
    await vi.advanceTimersByTimeAsync(20_000);
    let settled = false;
    void probing.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(isVideoError(await probing, "WORKER_START_FAILED")).toBe(true);
    await engine.destroy();
  });
});
