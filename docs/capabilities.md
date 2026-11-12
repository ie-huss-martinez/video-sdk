# Capability matrix

<!-- Generated from test/capabilities/matrix.ts by test/capabilities/capabilities.test.ts. Don't edit it by hand: change the matrix, then run `pnpm exec vitest run --project unit test/capabilities -u`. -->

What each browser engine in the test matrix offers the SDK, measured in a worker by `test/capabilities/capabilities.browser.test.ts` on every `pnpm test:browser:all` and in CI, with Playwright 1.65.0's builds. A browser that changes fails that test.

These are Playwright's builds, not every release of each browser. In particular, Playwright's WebKit on Linux is the GStreamer port, which decodes far fewer codecs than Safari on macOS and iOS. The SDK asks the browser it runs in, with `isConfigSupported`, before it opens a file or chooses an export's codecs (docs/adr/0001), so this table documents the test environment rather than limiting any browser.

## APIs

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux, GStreamer) |
|---|---|---|---|
| `VideoDecoder` in a worker | yes | yes | yes |
| `AudioDecoder` in a worker | yes | yes | yes |
| `VideoEncoder` in a worker | yes | yes | yes |
| `AudioEncoder` in a worker | yes | yes | yes |
| `VideoFrame` in a worker | yes | yes | yes |
| `OffscreenCanvas` in a worker | yes | yes | yes |
| `transferControlToOffscreen` on the page | yes | yes | yes |
| `AudioContext` on the page | yes | yes | yes |

## Decoding

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux, GStreamer) |
|---|---|---|---|
| H.264 (High) (`avc1.64001f`) | yes | yes | no |
| HEVC (Main) (`hvc1.1.6.L93.B0`) | no | no | no |
| VP8 (`vp8`) | yes | yes | yes |
| VP9 (`vp09.00.31.08`) | yes | yes | no |
| AV1 (Main) (`av01.0.05M.08`) | yes | yes | no |
| AAC-LC (`mp4a.40.2`) | yes | yes | no |
| Opus (`opus`) | yes | yes | yes |

## Encoding

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux, GStreamer) |
|---|---|---|---|
| H.264 (High) (`avc1.64001f`) | yes | yes | no |
| HEVC (Main) (`hvc1.1.6.L93.B0`) | no | no | no |
| VP8 (`vp8`) | yes | yes | yes |
| VP9 (`vp09.00.31.08`) | yes | yes | yes |
| AV1 (Main) (`av01.0.05M.08`) | yes | yes | no |
| AAC-LC (`mp4a.40.2`) | no | no | no |
| Opus (`opus`) | yes | yes | yes |
