import { videoLimits } from "../../core/errors/video-limits.js";
import { frontCheck } from "../front-check/front-check.js";
import { type FrameReader, openFrameReader } from "../mediabunny/frame-reader.js";
import type { PlaybackSource } from "./contract.js";

/**
 * The open readers of a worker's sources (docs/adr/0006): each source is
 * front-checked once, before mediabunny reads it, then kept open across
 * seeks, windows, exports and new plans, and released when the sources no
 * longer include it, or include another opening of it.
 *
 * Openings are compared, not files: every message clones a `Blob` into a
 * new object, so a file compared by identity is never the same twice, and
 * each new plan would close the reader its running decoder reads from.
 *
 * @internal
 */
export interface ReaderCache {
  /** The reader of a source, opening it on first use. Rejects with `TypeError` for a source not given. */
  readerFor(id: string): Promise<FrameReader>;
  /** Sets the sources, releasing the readers of any that left or were opened again. */
  setSources(sources: ReadonlyMap<string, PlaybackSource>): void;
  /** Releases every reader. */
  dispose(): void;
}

/**
 * How many readers this worker has opened and released, for the tests that
 * prove a new plan leaves the open readers alone (docs/adr/0006).
 *
 * @internal
 */
export const readerLedger = { opened: 0, released: 0 };

/**
 * Creates a reader cache.
 *
 * @internal
 */
export function createReaderCache(): ReaderCache {
  let sources: ReadonlyMap<string, PlaybackSource> = new Map();
  const readers = new Map<
    string,
    { readonly opening: number; readonly reader: Promise<FrameReader> }
  >();
  const release = (id: string) => {
    const open = readers.get(id);
    readers.delete(id);
    if (open) readerLedger.released += 1;
    void open?.reader.then(
      (reader) => reader.dispose(),
      () => {},
    );
  };
  return {
    readerFor(id) {
      const source = sources.get(id);
      if (!source) return Promise.reject(new TypeError(`The source "${id}" isn't loaded.`));
      const open = readers.get(id);
      if (open && open.opening === source.opening) return open.reader;
      readerLedger.opened += 1;
      const reader = (async () => {
        // The same front check as a probe, before mediabunny reads the file.
        await frontCheck(source.file, videoLimits.resolve(source.limits));
        return openFrameReader(source.file, source.probe);
      })();
      readers.set(id, { opening: source.opening, reader });
      reader.catch(() => {
        if (readers.get(id)?.reader === reader) readers.delete(id);
      });
      return reader;
    },
    setSources(next) {
      sources = next;
      for (const [id, open] of readers) {
        if (next.get(id)?.opening !== open.opening) release(id);
      }
    },
    dispose() {
      for (const id of [...readers.keys()]) release(id);
    },
  };
}
