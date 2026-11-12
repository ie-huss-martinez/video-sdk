/**
 * Size budgets per entry point (ADR 0015): the brotli size of each built
 * entry, with the shared chunks it loads. They measure the unminified files in
 * dist, an upper bound: applications ship less, because their bundler
 * minifies and drops what they don't import.
 *
 * These are starting ceilings for what each entry should hold. Worker
 * and video engine code loads lazily in its own chunks, which get
 * their own budgets when they're added. The feature pull requests revisit
 * these against real sizes.
 */
export default [
  {
    name: "Server-safe core (.), with the shared code it loads",
    path: ["dist/index.js", "dist/shared/*.js"],
    brotli: true,
    limit: "15 kB",
  },
  {
    name: "React entry (./react), with the shared code it loads",
    path: ["dist/react.js", "dist/shared/*.js"],
    brotli: true,
    limit: "40 kB",
  },
  {
    name: "Element entry (./element), with the shared code it loads",
    path: ["dist/element.js", "dist/shared/*.js"],
    brotli: true,
    limit: "40 kB",
  },
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
    // The page's audio player, loaded on the first play of a plan with audio
    // (docs/adr/0006): scheduling windows, the lead, gapless switches and the
    // watchdog. It measures about 1.7 kB.
    name: "Audio player (lazy)",
    path: "dist/lazy/playback-audio-*.js",
    brotli: true,
    limit: "4 kB",
  },
];
