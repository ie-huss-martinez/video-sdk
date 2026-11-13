/**
 * Size budgets per entry point (ADR 0015): the brotli size of each built
 * entry, with the shared chunks it loads, and only those. They measure the unminified files in
 * dist, an upper bound: applications ship less, because their bundler
 * minifies and drops what they don't import.
 *
 * These are starting ceilings for what each entry should hold. Worker
 * and video engine code loads lazily in its own chunks, which get
 * their own budgets when they're added. The feature pull requests revisit
 * these against real sizes.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * The built files an entry loads up front: the entry, and every chunk it
 * imports statically, directly or through other chunks. Counting only these,
 * rather than every shared chunk, keeps one entry's budget from paying for
 * code that only another entry loads, such as the React editor's in the
 * core's. Chunks loaded with `import()`, in `lazy/`, have budgets of their
 * own, as in ai-core.
 */
function loadedFiles(file) {
  const seen = new Set();
  const visit = (path) => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const code = readFileSync(path, "utf8");
    for (const [, specifier] of code.matchAll(/(?:from\s*|import\s+)"(\.{1,2}\/[^"]+\.js)"/g)) {
      visit(normalize(join(dirname(path), specifier)));
    }
  };
  visit(join("dist", file));
  return [...seen];
}

const entry = (name, file, limit) => ({
  name: `${name}, with the shared code it loads`,
  path: loadedFiles(file),
  brotli: true,
  limit,
});

export default [
  // 20 kB since the portable plan format (sdk-core ADR 0045): its strict
  // readers and document reader and writer took the core from 13.7 to 17.5 kB.
  entry("Server-safe core (.)", "index.js", "20 kB"),
  entry("React entry (./react)", "react.js", "40 kB"),
  entry("Element entry (./element)", "element.js", "40 kB"),
  {
    name: "Stylesheet (./styles.css)",
    path: "dist/styles.css",
    brotli: true,
    limit: "10 kB",
  },
  {
    // The media worker, inlined as a minified string and loaded on the first
    // call (docs/adr/0002): the front check, the packet walk, mediabunny's
    // MP4 and Matroska readers (docs/adr/0001), decoding, and playback's
    // scheduler and drawing (docs/adr/0006). It measures about 53 kB.
    name: "Media worker, inlined (lazy)",
    path: "dist/lazy/inline-worker-*.js",
    brotli: true,
    limit: "60 kB",
  },
  {
    // The media worker as self-hosted under assetsUrl (sdk-core ADR 0038):
    // the same code as the inlined one, as one file.
    name: "Media worker, self-hosted",
    path: "dist/assets/video/media.worker.js",
    brotli: true,
    limit: "60 kB",
  },
  {
    name: "Export worker, self-hosted",
    path: "dist/assets/video/export.worker.js",
    brotli: true,
    limit: "90 kB",
  },
  {
    // The export worker, inlined and loaded on the first export
    // (docs/adr/0002, docs/adr/0005): the readers and decoders as in the
    // media worker, the compose step and mixer, and mediabunny's MP4 and
    // WebM muxers (docs/adr/0001).
    name: "Export worker, inlined (lazy)",
    path: "dist/lazy/export-inline-worker-*.js",
    brotli: true,
    limit: "90 kB",
  },
  {
    // The page's side of an export, loaded on the first export: the worker
    // client and the stall-based processing time.
    name: "Export runner (lazy)",
    path: "dist/lazy/runner-*.js",
    brotli: true,
    limit: "2 kB",
  },
  {
    // The page's audio player, loaded on the first play of a plan with audio
    // (docs/adr/0006): scheduling windows, the lead, gapless switches and the
    // watchdog. It measures about 1.7 kB.
    name: "Audio player (lazy)",
    path: "dist/lazy/playback-audio-*.js",
    brotli: true,
    limit: "4 kB",
  },
];
