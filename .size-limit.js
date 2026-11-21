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
import { entryBudget, importBudget } from "@hussmartinez/sdk-config/size";

/**
 * An application's import from the core entry, as sdk-config's
 * `importBudget` measures it (sdk-core ADR 0056): bundled and minified with
 * esbuild, without React, the family's packages and the lazy workers,
 * compressed with brotli. A floor's limit is its size rounded up to the next
 * 0.1 kB, and is never raised; the others round up to the next 0.5 kB.
 */
const coreImport = (name, imports, limit) =>
  importBudget({ name, entry: "dist/index.js", imports, limit });

/** An application's import from the React entry, measured the same way. */
const reactImport = (name, imports, limit) =>
  importBudget({ name, entry: "dist/react.js", imports, limit });

export default [
  // 20 kB since the portable plan format (sdk-core ADR 0045): its strict
  // readers and document reader and writer took the core from 13.7 to 17.5 kB.
  // 20.5 kB since the waveform (ADR 0008): the session's peaks, built in the
  // background with getPeaks, and peakColumns took it from 19.84 to 20.34 kB.
  // 21 kB since session.open (ADR 0003): opening a file in place of the plan,
  // as audio-sdk's session does, took it from 20.36 to 20.55 kB.
  // 19 kB since the editor's interface text left this entry (sdk-core ADR
  // 0059): its 139 keys took it from 20.53 to 18.58 kB.
  entryBudget({
    name: "Server-safe core (.), with the shared code it loads",
    entry: "dist/index.js",
    limit: "19 kB",
  }),
  entryBudget({
    name: "React entry (./react), with the shared code it loads",
    entry: "dist/react.js",
    limit: "40 kB",
  }),
  entryBudget({
    name: "Element entry (./element), with the shared code it loads",
    entry: "dist/element.js",
    limit: "40 kB",
  }),
  {
    // As built, as a file: not bundled again by size-limit's esbuild plugin.
    disablePlugins: ["@size-limit/esbuild"],
    name: "Stylesheet (./styles.css)",
    path: "dist/styles.css",
    brotli: true,
    limit: "10 kB",
  },
  {
    disablePlugins: ["@size-limit/esbuild"],
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
    disablePlugins: ["@size-limit/esbuild"],
    // The media worker as self-hosted under assetsUrl (sdk-core ADR 0038):
    // the same code as the inlined one, as one file.
    name: "Media worker, self-hosted",
    path: "dist/assets/video/media.worker.js",
    brotli: true,
    limit: "60 kB",
  },
  {
    disablePlugins: ["@size-limit/esbuild"],
    name: "Export worker, self-hosted",
    path: "dist/assets/video/export.worker.js",
    brotli: true,
    limit: "90 kB",
  },
  {
    disablePlugins: ["@size-limit/esbuild"],
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
    disablePlugins: ["@size-limit/esbuild"],
    // The page's side of an export, loaded on the first export: the worker
    // client and the stall-based processing time.
    name: "Export runner (lazy)",
    path: "dist/lazy/runner-*.js",
    brotli: true,
    limit: "2 kB",
  },
  {
    disablePlugins: ["@size-limit/esbuild"],
    // The page's audio player, loaded on the first play of a plan with audio
    // (docs/adr/0006): scheduling windows, the lead, gapless switches and the
    // watchdog. It measures about 1.7 kB.
    name: "Audio player (lazy)",
    path: "dist/lazy/playback-audio-*.js",
    brotli: true,
    limit: "4 kB",
  },
  // What applications import (sdk-core ADR 0056), measured by size-limit
  // with @size-limit/esbuild. A floor catches code that leaks into every
  // import: one that moves is a regression to fix, never a limit to raise.
  // The core's floor, measured 78 B: the error class.
  coreImport("Import: the floor, VideoError", "{ VideoError }", "0.1 kB"),
  // Measured 7.69 kB: the session, the plan's reducer and history, the
  // limits, and the text of errors and warnings. It was 10.58 kB while the
  // catalogue leaked into every core import (#139).
  coreImport("Import: createVideoSession", "{ createVideoSession }", "8 kB"),
  // Measured 4.52 kB: the commands and the plan's validation.
  coreImport("Import: createVideoReducer", "{ createVideoReducer }", "5 kB"),
  // Measured 3.57 kB: playback's page side, its clock and the lazy audio
  // player's loader (docs/adr/0006).
  coreImport("Import: createVideoOutput", "{ createVideoOutput }", "4 kB"),
  // Measured 1.56 kB: the English catalogue of what the headless API hands a
  // host to show, sdk-core's text and the SDK's errors and warnings. It was
  // 3.45 kB with the editor's interface text (sdk-core ADR 0059).
  coreImport("Import: videoMessages", "{ videoMessages }", "2 kB"),
  // Measured 2.85 kB: reading hm-video-plan documents (sdk-core ADR 0045).
  coreImport("Import: readVideoPlanDocument", "{ readVideoPlanDocument }", "3 kB"),
  // Measured 2.17 kB: the engine's page side, which starts the media worker.
  coreImport("Import: createVideoEngine", "{ createVideoEngine }", "2.5 kB"),
  // Measured 12.11 kB: what a headless editor imports, shared code counted
  // once. It was 14.08 kB with the editor's interface text in the catalogue.
  coreImport(
    "Import: an editor's set",
    "{ createVideoSession, createVideoEngine, createVideoProcessor, createVideoOutput, videoMessages }",
    "12.5 kB",
  ),
  // The React entry's floor, measured 634 B: a hook and the editor's
  // context. It was 18.57 kB before the entry came apart (#131).
  reactImport("Import: the floor, useVideoSession (./react)", "{ useVideoSession }", "0.7 kB"),
  // Measured 2.04 kB: the toolbar and the tool registry it renders.
  reactImport("Import: VideoToolbar (./react)", "{ VideoToolbar }", "2.5 kB"),
  // Measured 2.71 kB: playback's controls and their notices.
  reactImport("Import: VideoTransport (./react)", "{ VideoTransport }", "3 kB"),
  // Measured 3.35 kB: the export dialog, its summary and progress. It was
  // 6.26 kB before sdk-core ADR 0059's split.
  reactImport("Import: VideoExportDialog (./react)", "{ VideoExportDialog }", "3.5 kB"),
  // Measured 4.32 kB: the timeline, its clips, trimming and the waveform.
  reactImport("Import: VideoTimeline (./react)", "{ VideoTimeline }", "4.5 kB"),
  // Measured 5.42 kB: the stage, its canvas and output, the drop zone and
  // the notices. It was 8.37 kB before sdk-core ADR 0059's split.
  reactImport("Import: VideoStage (./react)", "{ VideoStage }", "5.5 kB"),
  // Measured 6.07 kB: the inspector's sound, picture and metadata.
  reactImport("Import: VideoInspector (./react)", "{ VideoInspector }", "6.5 kB"),
  // Measured 13.96 kB: the provider, which makes the session and the engine.
  reactImport("Import: VideoEditorProvider (./react)", "{ VideoEditorProvider }", "14 kB"),
  // Measured 26.08 kB: the whole editor, what a typical application imports.
  reactImport("Import: VideoEditor, the whole editor (./react)", "{ VideoEditor }", "26.5 kB"),
];
