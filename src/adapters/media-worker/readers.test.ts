import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoProbe } from "../../core/model/source.js";
import type { PlaybackSource } from "./contract.js";

const opened: { file: Blob; disposed: boolean }[] = [];
vi.mock("../front-check/front-check.js", () => ({ frontCheck: async () => {} }));
vi.mock("../mediabunny/frame-reader.js", () => ({
  openFrameReader: async (file: Blob) => {
    const reader = { file, disposed: false, dispose: () => (reader.disposed = true) };
    opened.push(reader);
    return reader;
  },
}));

const { createReaderCache } = await import("./readers.js");

afterEach(() => {
  opened.length = 0;
});

/** A source as the worker receives it: every message clones the Blob into a new object. */
const received = (id: string, opening: number): PlaybackSource => ({
  id,
  opening,
  file: new Blob(["the same bytes"]),
  probe: { start: 0 } as VideoProbe,
  limits: {} as PlaybackSource["limits"],
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the worker's readers", () => {
  it("keeps a source's reader open when the same opening is sent again, as with every new plan", async () => {
    const cache = createReaderCache();
    cache.setSources(new Map([["a", received("a", 1)]]));
    const first = await cache.readerFor("a");
    // A new plan, such as a volume change: the same source, in a new Blob object.
    for (let plan = 0; plan < 5; plan += 1) cache.setSources(new Map([["a", received("a", 1)]]));
    await settle();
    expect(await cache.readerFor("a")).toBe(first);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.disposed).toBe(false);
    cache.dispose();
  });

  it("releases a reader when its source leaves, or is opened again under the same id", async () => {
    const cache = createReaderCache();
    cache.setSources(new Map([["a", received("a", 1)]]));
    await cache.readerFor("a");
    cache.setSources(new Map([["a", received("a", 2)]]));
    await settle();
    expect(opened[0]?.disposed).toBe(true);
    await cache.readerFor("a");
    expect(opened).toHaveLength(2);
    cache.setSources(new Map());
    await settle();
    expect(opened[1]?.disposed).toBe(true);
    await expect(cache.readerFor("a")).rejects.toThrow(TypeError);
  });
});
