import { describe, expect, inject, it } from "vitest";
import { server } from "vitest/browser";
import { CODECS, DECODE_FIXTURES, type Engine, MATRIX, type PAGE_FEATURES } from "./matrix.js";

// The capability matrix, checked in each engine (docs/capabilities.md). It
// holds in the pinned browser image, where CI runs; another machine's
// browsers can differ, so elsewhere these skip.
describe.skipIf(!inject("browserImage"))(`the capability matrix in ${server.browser}`, () => {
  const expected = MATRIX[server.browser as Engine];

  it("matches what this engine offers in a worker", async () => {
    const worker = new Worker(new URL("./capabilities.worker.ts", import.meta.url), {
      type: "module",
    });
    const measured = await new Promise<unknown>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
      void fixtures().then((files) => worker.postMessage(files));
    });
    worker.terminate();
    expect(measured).toEqual({
      worker: expected.worker,
      decode: expected.decode,
      decodes: expected.decodes,
      encode: expected.encode,
      draw: expected.draw,
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

/** Every codec's fixture, fetched from the test server. */
async function fixtures(): Promise<Record<string, Blob>> {
  const files: Record<string, Blob> = {};
  for (const { id } of CODECS) {
    const url = new URL(`../fixtures/video/${DECODE_FIXTURES[id].file}`, import.meta.url);
    files[id] = await (await fetch(url)).blob();
  }
  return files;
}
