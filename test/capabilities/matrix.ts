// The capability matrix (docs/adr/0001, docs/adr/0002): what each browser
// engine in the test matrix offers the SDK. capabilities.browser.test.ts
// checks it in every engine, so a browser that changes fails a test, not a
// user, and capabilities.test.ts renders docs/capabilities.md from it.

/** The engines Vitest's browser mode runs, through Playwright. */
export type Engine = "chromium" | "firefox" | "webkit";

/** APIs the SDK needs in its workers (docs/adr/0002). */
export const WORKER_FEATURES = [
  "VideoDecoder",
  "AudioDecoder",
  "VideoEncoder",
  "AudioEncoder",
  "VideoFrame",
  "OffscreenCanvas",
] as const;

/** APIs the SDK needs on the page. */
export const PAGE_FEATURES = ["transferControlToOffscreen", "AudioContext"] as const;

/** The codecs in the matrix, with a configuration to ask WebCodecs about. */
export const CODECS = [
  { id: "h264", label: "H.264 (High)", kind: "video", codec: "avc1.64001f" },
  { id: "hevc", label: "HEVC (Main)", kind: "video", codec: "hvc1.1.6.L93.B0" },
  { id: "vp8", label: "VP8", kind: "video", codec: "vp8" },
  { id: "vp9", label: "VP9", kind: "video", codec: "vp09.00.31.08" },
  { id: "av1", label: "AV1 (Main)", kind: "video", codec: "av01.0.05M.08" },
  { id: "aac", label: "AAC-LC", kind: "audio", codec: "mp4a.40.2" },
  { id: "opus", label: "Opus", kind: "audio", codec: "opus" },
] as const;

export type CodecId = (typeof CODECS)[number]["id"];

export interface Capabilities {
  readonly worker: Record<(typeof WORKER_FEATURES)[number], boolean>;
  readonly page: Record<(typeof PAGE_FEATURES)[number], boolean>;
  readonly decode: Record<CodecId, boolean>;
  readonly encode: Record<CodecId, boolean>;
}

/** The browser versions the matrix was last measured with, for the record. */
export const MEASURED = {
  playwright: "1.65.0",
  chromium: "Chromium 158",
  firefox: "Firefox 159",
  webkit: "WebKit 27.2 (Linux, GStreamer)",
} as const;

const ALL_FEATURES = {
  worker: {
    VideoDecoder: true,
    AudioDecoder: true,
    VideoEncoder: true,
    AudioEncoder: true,
    VideoFrame: true,
    OffscreenCanvas: true,
  },
  page: { transferControlToOffscreen: true, AudioContext: true },
} as const;

export const MATRIX: Record<Engine, Capabilities> = {
  chromium: {
    ...ALL_FEATURES,
    decode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    encode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: false, opus: true },
  },
  firefox: {
    ...ALL_FEATURES,
    decode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    encode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: false, opus: true },
  },
  webkit: {
    ...ALL_FEATURES,
    decode: { h264: false, hevc: false, vp8: true, vp9: false, av1: false, aac: false, opus: true },
    encode: { h264: false, hevc: false, vp8: true, vp9: true, av1: false, aac: false, opus: true },
  },
};

const ENGINES: readonly Engine[] = ["chromium", "firefox", "webkit"];
const mark = (value: boolean) => (value ? "yes" : "no");

/** docs/capabilities.md, rendered from the matrix. */
export function renderCapabilities(): string {
  const header = `| | ${ENGINES.map((engine) => MEASURED[engine]).join(" | ")} |\n|---|${ENGINES.map(() => "---").join("|")}|`;
  const row = (label: string, value: (engine: Engine) => boolean) =>
    `| ${label} | ${ENGINES.map((engine) => mark(value(engine))).join(" | ")} |`;
  return [
    "# Capability matrix",
    "",
    "<!-- Generated from test/capabilities/matrix.ts by test/capabilities/capabilities.test.ts. Don't edit it by hand: change the matrix, then run `pnpm exec vitest run --project unit test/capabilities -u`. -->",
    "",
    `What each browser engine in the test matrix offers the SDK, measured in a worker by \`test/capabilities/capabilities.browser.test.ts\` on every \`pnpm test:browser:all\` and in CI, with Playwright ${MEASURED.playwright}'s builds. A browser that changes fails that test.`,
    "",
    "These are Playwright's builds, not every release of each browser. In particular, Playwright's WebKit on Linux is the GStreamer port, which decodes far fewer codecs than Safari on macOS and iOS. The SDK asks the browser it runs in, with `isConfigSupported`, before it opens a file or chooses an export's codecs (docs/adr/0001), so this table documents the test environment rather than limiting any browser.",
    "",
    "## APIs",
    "",
    header,
    ...WORKER_FEATURES.map((feature) =>
      row(`\`${feature}\` in a worker`, (engine) => MATRIX[engine].worker[feature]),
    ),
    ...PAGE_FEATURES.map((feature) =>
      row(`\`${feature}\` on the page`, (engine) => MATRIX[engine].page[feature]),
    ),
    "",
    "## Decoding",
    "",
    header,
    ...CODECS.map((codec) =>
      row(`${codec.label} (\`${codec.codec}\`)`, (engine) => MATRIX[engine].decode[codec.id]),
    ),
    "",
    "## Encoding",
    "",
    header,
    ...CODECS.map((codec) =>
      row(`${codec.label} (\`${codec.codec}\`)`, (engine) => MATRIX[engine].encode[codec.id]),
    ),
    "",
  ].join("\n");
}
