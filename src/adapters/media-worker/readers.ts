import { videoLimits } from "../../core/errors/video-limits.js";
import { frontCheck } from "../front-check/front-check.js";
import { type FrameReader, openFrameReader } from "../mediabunny/frame-reader.js";
import type { PlaybackSource } from "./contract.js";

/**
 * The open readers of a worker's sources (docs/adr/0006): each source is
 * front-checked once, before mediabunny reads it, then kept open across
 * seeks, windows and exports, and released when the sources no longer
 * include it.
 *
 * @internal
 */
export interface ReaderCache {
  /** The reader of a source, opening it on first use. Rejects with `TypeError` for a source not given. */
  readerFor(id: string): Promise<FrameReader>;
  /** Sets the sources, releasing the readers of any that left or changed file. */
  setSources(sources: ReadonlyMap<string, PlaybackSource>): void;
  /** Releases every reader. */
  dispose(): void;
}

/**
 * Creates a reader cache.
 *
 * @internal
 */
export function createReaderCache(): ReaderCache {
  let sources: ReadonlyMap<string, PlaybackSource> = new Map();
  const readers = new Map<string, { readonly file: Blob; readonly reader: Promise<FrameReader> }>();
  const release = (id: string) => {
    const open = readers.get(id);
    readers.delete(id);
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
      if (open && open.file === source.file) return open.reader;
      const reader = (async () => {
        // The same front check as a probe, before mediabunny reads the file.
        await frontCheck(source.file, videoLimits.resolve(source.limits));
        return openFrameReader(source.file, source.probe);
      })();
      readers.set(id, { file: source.file, reader });
      reader.catch(() => {
        if (readers.get(id)?.reader === reader) readers.delete(id);
      });
      return reader;
    },
    setSources(next) {
      sources = next;
      for (const [id, open] of readers) {
        if (next.get(id)?.file !== open.file) release(id);
      }
    },
    dispose() {
      for (const id of [...readers.keys()]) release(id);
    },
  };
}
