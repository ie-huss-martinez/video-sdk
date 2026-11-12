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
  /** What `isConfigSupported` claims for decoding. */
  readonly decode: Record<CodecId, boolean>;
  /** Whether a real file in the codec decodes, through the SDK's decoder for video. */
  readonly decodes: Record<CodecId, boolean>;
  readonly encode: Record<CodecId, boolean>;
}

/** The fixture each codec is decoded from, and which of its tracks. */
export const DECODE_FIXTURES: Record<
  CodecId,
  { readonly file: string; readonly track: "video" | "audio" }
> = {
  h264: { file: "landscape.mp4", track: "video" },
  hevc: { file: "hevc.mp4", track: "video" },
  vp8: { file: "landscape-vp8.webm", track: "video" },
  vp9: { file: "landscape.webm", track: "video" },
  av1: { file: "av1.mp4", track: "video" },
  aac: { file: "landscape.mp4", track: "audio" },
  opus: { file: "landscape.webm", track: "audio" },
};

/** The browser versions the matrix was last measured with, for the record. */
export const MEASURED = {
  playwright: "1.65.0",
  chromium: "Chromium 158",
  firefox: "Firefox 159",
  webkit: "WebKit 27.2 (Linux)",
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
    decodes: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    encode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: false, opus: true },
  },
  firefox: {
    ...ALL_FEATURES,
    decode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    decodes: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    encode: { h264: true, hevc: false, vp8: true, vp9: true, av1: true, aac: false, opus: true },
  },
  // WebKit on Linux answers from the image's GStreamer plugins, which claim
  // every codec here, HEVC included.
  webkit: {
    ...ALL_FEATURES,
    decode: { h264: true, hevc: true, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    decodes: { h264: true, hevc: true, vp8: true, vp9: true, av1: true, aac: true, opus: true },
    encode: { h264: true, hevc: true, vp8: true, vp9: true, av1: true, aac: true, opus: true },
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
    `What each browser engine in the test matrix offers the SDK: Playwright ${MEASURED.playwright}'s builds, in the pinned browser test image of \`ci/Dockerfile\` (sdk-core ADR 0025), where CI runs. \`test/capabilities/capabilities.browser.test.ts\` measures it in a worker in that image, in CI and with \`pnpm test:browser:image\`, so a browser that changes fails a test. Elsewhere it skips, because another machine's browsers can differ.`,
    "",
    "These are Playwright's builds, not every release of each browser. Playwright's WebKit on Linux answers from the system's GStreamer plugins: in the image they claim every codec here, while on a machine with fewer plugins the same WebKit decodes only VP8 and Opus. Neither is Safari. The \"Decoding a real file\" table records whether each claim holds. The SDK asks the browser it runs in, with `isConfigSupported`, before it opens a file or chooses an export's codecs (docs/adr/0001), so this table documents the test environment rather than limiting any browser.",
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
    "## Decoding, as claimed",
    "",
    "What `VideoDecoder.isConfigSupported` and `AudioDecoder.isConfigSupported` answer.",
    "",
    header,
    ...CODECS.map((codec) =>
      row(`${codec.label} (\`${codec.codec}\`)`, (engine) => MATRIX[engine].decode[codec.id]),
    ),
    "",
    "## Decoding a real file",
    "",
    "Whether a generated file in the codec really decodes: ten video frames through the SDK's own decoder, or ten audio packets through `AudioDecoder`.",
    "",
    header,
    ...CODECS.map((codec) =>
      row(
        `${codec.label}, from \`${DECODE_FIXTURES[codec.id].file}\``,
        (engine) => MATRIX[engine].decodes[codec.id],
      ),
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
