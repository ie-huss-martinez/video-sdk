# Capability matrix

<!-- Generated from test/capabilities/matrix.ts by test/capabilities/capabilities.test.ts. Don't edit it by hand: change the matrix, then run `pnpm exec vitest run --project unit test/capabilities -u`. -->

What each browser engine in the test matrix offers the SDK: Playwright 1.65.0's builds, in the pinned browser test image of `ci/Dockerfile` (sdk-core ADR 0025), where CI runs. `test/capabilities/capabilities.browser.test.ts` measures it in a worker in that image, in CI and with `pnpm test:browser:image`, so a browser that changes fails a test. Elsewhere it skips, because another machine's browsers can differ.

These are Playwright's builds, not every release of each browser. Playwright's WebKit on Linux answers from the system's GStreamer plugins: in the image they claim every codec here, while on a machine with fewer plugins the same WebKit decodes only VP8 and Opus. Neither is Safari. The "Decoding a real file" table records whether each claim holds. The SDK asks the browser it runs in, with `isConfigSupported`, before it opens a file or chooses an export's codecs (docs/adr/0001), so this table documents the test environment rather than limiting any browser.

## APIs

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux) |
|---|---|---|---|
| `VideoDecoder` in a worker | yes | yes | yes |
| `AudioDecoder` in a worker | yes | yes | yes |
| `VideoEncoder` in a worker | yes | yes | yes |
| `AudioEncoder` in a worker | yes | yes | yes |
| `VideoFrame` in a worker | yes | yes | yes |
| `OffscreenCanvas` in a worker | yes | yes | yes |
| `transferControlToOffscreen` on the page | yes | yes | yes |
| `AudioContext` on the page | yes | yes | yes |

## Decoding, as claimed

What `VideoDecoder.isConfigSupported` and `AudioDecoder.isConfigSupported` answer.

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux) |
|---|---|---|---|
| H.264 (High) (`avc1.64001f`) | yes | yes | yes |
| HEVC (Main) (`hvc1.1.6.L93.B0`) | no | no | yes |
| VP8 (`vp8`) | yes | yes | yes |
| VP9 (`vp09.00.31.08`) | yes | yes | yes |
| AV1 (Main) (`av01.0.05M.08`) | yes | yes | yes |
| AAC-LC (`mp4a.40.2`) | yes | yes | yes |
| Opus (`opus`) | yes | yes | yes |

## Decoding a real file

Whether a generated file in the codec really decodes: ten video frames through the SDK's own decoder, or ten audio packets through `AudioDecoder`.

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux) |
|---|---|---|---|
| H.264 (High), from `landscape.mp4` | yes | yes | yes |
| HEVC (Main), from `hevc.mp4` | no | no | yes |
| VP8, from `landscape-vp8.webm` | yes | yes | yes |
| VP9, from `landscape.webm` | yes | yes | yes |
| AV1 (Main), from `av1.mp4` | yes | yes | yes |
| AAC-LC, from `landscape.mp4` | yes | yes | yes |
| Opus, from `landscape.webm` | yes | yes | yes |

## Encoding

| | Chromium 158 | Firefox 159 | WebKit 27.2 (Linux) |
|---|---|---|---|
| H.264 (High) (`avc1.64001f`) | yes | yes | yes |
| HEVC (Main) (`hvc1.1.6.L93.B0`) | no | no | yes |
| VP8 (`vp8`) | yes | yes | yes |
| VP9 (`vp09.00.31.08`) | yes | yes | yes |
| AV1 (Main) (`av01.0.05M.08`) | yes | yes | yes |
| AAC-LC (`mp4a.40.2`) | no | no | yes |
| Opus (`opus`) | yes | yes | yes |
