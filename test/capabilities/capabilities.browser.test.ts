import { describe, expect, it } from "vitest";
import { server } from "vitest/browser";
import { type Engine, MATRIX, type PAGE_FEATURES } from "./matrix.js";

// The capability matrix, checked in each engine (docs/capabilities.md).
describe(`the capability matrix in ${server.browser}`, () => {
  const expected = MATRIX[server.browser as Engine];

  it("matches what this engine offers in a worker", async () => {
    const worker = new Worker(new URL("./capabilities.worker.ts", import.meta.url), {
      type: "module",
    });
    const measured = await new Promise<unknown>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.postMessage(undefined);
    });
    worker.terminate();
    expect(measured).toEqual({
      worker: expected.worker,
      decode: expected.decode,
      encode: expected.encode,
    });
  });

  it("matches what this engine offers on the page", () => {
    const canvas = document.createElement("canvas");
    const page = {
      transferControlToOffscreen: typeof canvas.transferControlToOffscreen === "function",
      AudioContext: typeof AudioContext === "function",
    } satisfies Record<(typeof PAGE_FEATURES)[number], boolean>;
    expect(page).toEqual(expected.page);
  });
});
