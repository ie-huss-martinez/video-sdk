# 0002. A media worker that owns decoding and the preview, an export worker, and assets without the network

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-13, when self-hosting was built: which functions take `assetsUrl`. Earlier, 2026-11-12, when playback found a deadlock in Firefox: a decoder that holds a full queue without output may take more packets, up to a hard cap; and when playback was built: each output draws in a media worker of its own, which lives as long as the output.

## Context

[ADR 0001](0001-video-engines.md) puts reading containers, decoding and encoding in workers. Video differs from the family's other SDKs in where decoded data is needed and how long it may live:

- **Video frames are needed where they're drawn.** The preview draws dozens of them every second. If they lived on the page, every frame would cross from the worker; if they're drawn in the worker, they never have to. The 2D `OffscreenCanvas` and `HTMLCanvasElement.transferControlToOffscreen()` let the worker draw straight into a canvas the page shows, as image-sdk's render worker does ([image-sdk ADR 0002](https://github.com/ie-huss-martinez/image-sdk/blob/main/docs/adr/0002-workers-and-assets.md)).
- **Audio is needed on the page.** Web Audio's `AudioContext` doesn't exist in workers, so decoded audio must reach the page to be heard.
- **Decoded media can't be kept.** audio-sdk keeps whole decoded sources on the page. A decoded video can't be kept at all: one 4K frame is about 33 MB. Frames are decoded, drawn or encoded, and closed.
- **Exports are long.** A user who cancels one, or a browser that stalls in an encoder, must not take the preview down with it.

The family's workers use `sdk-core`'s typed RPC ([ADR 0018](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0018-worker-rpc-protocol.md)). Assets are inlined by default and self-hostable through `assetsUrl` ([ADR 0038](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0038-self-hosted-assets-and-worker-version.md)).

## Decision

### Where the media lives

- **The page keeps each source's original `Blob`,** which costs nothing extra, because the browser already holds the file. Workers receive the `Blob` itself, which crosses threads without copying its bytes, and read it in slices ([ADR 0001](0001-video-engines.md)).
  - No session data lives only in a worker. If a worker crashes or is terminated, the session creates a new one, probes and opens the sources again from their `Blob`s, and redraws.
- **Decoded video frames live only in the worker that decoded them.** They're drawn or encoded there and closed. No full-size `VideoFrame` or frame pixel buffer is ever posted to the page; thumbnails are posted as small `ImageBitmap`s.
- **Decoded audio for playback goes to the page in short windows,** as one transferred `Float32Array` per channel, for the page's `AudioContext`. The window length and how playback schedules them are a later record on playback ([ADR 0005](0005-playback-and-export.md)). Waveform peaks are computed in the worker and posted as small arrays.
- **Memory is bounded by queues, not by footage.** Every decoder, decoded-frame queue and encoder in a worker has a fixed maximum length:
  - **the decoder's own queue:** at most 8 packets. A decoder that holds all 8 for 50 milliseconds without output, with no decoded frame waiting, gets one more at a time, up to 32. Firefox decodes VP8 on several threads at once and outputs nothing until about as many packets as it has threads are in flight, which can be more than 8; without this, the loop would wait for an output and the decoder for a packet, forever. The bound stays fixed, at 32 packets: a decoder that holds all 32 without output fails at once with `DECODE_FAILED` and `details.reason: "stalled"`, rather than waiting out the processing time;
  - **decoded frames waiting to be drawn or encoded:** at most 4;
  - **the encoder's queue:** at most 8 frames.

  When a queue is full, the loop waits for the consumer.
- **Every `VideoFrame` and `AudioData` is closed on every path:** after drawing or encoding, and in `finally` blocks for seek, cancellation, errors and teardown. Each worker counts the frames it has open in a test-only counter.
- **The session counts what the workers cache,** such as thumbnails and peaks, against the session memory limit ([ADR 0004](0004-video-limits.md)). It does so from sizes it already knows, so it never has to ask a worker.

### The preview: a transferred canvas

- **The editor's canvas is transferred to the media worker** with `transferControlToOffscreen()`, once per mount. The worker draws the frame at the playhead into it, at the stage's size scaled to the device pixel ratio, through the same compose step as export.
- **Scrubbing coalesces requests:** when seeks arrive faster than the worker can decode, only the latest is drawn.
- **Playback** is paced by a clock that a later record on playback defines ([ADR 0005](0005-playback-and-export.md)).
- **Everything interactive stays in the DOM on the page:** the timeline, trim handles, playhead, transport, crop frame, focus and the keyboard. They're positioned from geometry that the page and the worker share as pure code, so nothing in the accessibility tree depends on the worker.
- **Missing features fail clearly.** Without WebCodecs' `VideoDecoder`, `AudioDecoder`, `VideoEncoder` and `AudioEncoder` in workers, a 2D `OffscreenCanvas` in workers, or `transferControlToOffscreen`, the editor fails with `UNSUPPORTED_ENVIRONMENT` and `details.feature`, as [ADR 0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md) requires.
- **The capability matrix checks every one of these** in workers on Chromium, Firefox and WebKit, together with which codecs decode and encode ([ADR 0001](0001-video-engines.md)). So a browser that changes fails a test, not a user.

### The workers: the family RPC

Each worker module exposes its side with `exposeWorker`. The ports that reach them with `createWorkerClient` are named in a later record on the document model ([ADR 0003](0003-clip-plan-document-model.md)).

**The media worker:**

- **`probe(file)`:** the front check and the packet walk ([ADR 0001](0001-video-engines.md)).
- **`open(id, file, probe)`:** opens a probed source for reading. Decoders are configured only when a frame or audio is first needed.
- **`attachCanvas(canvas)`:** takes the transferred canvas.
- **`seek(plan, time, view)`:** draws the frame at `time` into it.
- **`play(plan, from, view)`** and **`pause()`:** drive playback.
- **`audio(plan, from, length)`:** decodes, mixes and returns a window of audio for the page.
- **`thumbnails(id, times, size)`:** small `ImageBitmap`s for the timeline, transferred to the page.
- **`peaks(id)`:** waveform peaks for a source's audio track.
- **`close(id)`:** closes a source's decoders and reader once nothing refers to it.

**The export worker:**

- **`export(plan, sources, options)`:** reads, decodes, composes, encodes and writes the plan ([ADR 0001](0001-video-engines.md)). It reports progress, and returns the output as a `Blob`.

Every call takes an `AbortSignal` and runs under `withProcessingTime`. Long calls, such as probing large files and exporting, report progress. Failures reach callers as `VideoError`s, adapted with `sdk-core`'s `createErrorHelpers` ([ADR 0034](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0034-shared-error-helpers.md)), so an aborted call keeps the file policy's code, and the browser's own messages never reach users.

### Clients and lifetimes

- **Two kinds of worker, each with its own client.**
  - **The media worker** probes, opens and builds thumbnails. It starts with the first file and stops with its session.
  - **Each output plays in a media worker of its own:** the same module, started by the output with the canvas, and terminated when the output is destroyed. A worker holding a transferred canvas can't be stopped when idle and started again, because a canvas can be transferred only once. So it can't share the engine's client, which `sdk-core` terminates after its idle timeout. Keeping it separate also means a probe can't delay a frame, and a crash in playback doesn't fail a probe. Sources reach it as their `Blob`s and probes, which cost nothing to send.
  - **The export worker** starts with the first export and stops after `sdk-core`'s idle timeout.
- **One export at a time per session;** a second request while one runs fails with `BUSY`.
- **Cancelling an export** aborts its call. If the export worker doesn't settle within `sdk-core`'s cancel timeout, it's terminated. The media worker and the preview are untouched either way ([ADR 0018](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0018-worker-rpc-protocol.md)).

### Assets

- **Inline (the default):** both workers are inlined and started from `blob:` URLs.
- **Self-hosted:** `assetsUrl` is where the application serves the package's `dist/assets/` directory ([ADR 0038](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0038-self-hosted-assets-and-worker-version.md)), resolved with `sdk-core`'s `resolveAssetsBase`. The workers are `video/media.worker.js` and `video/export.worker.js` under it, each one minified file with a fixed name.
  - **As built:** `createVideoEngine` and `createVideoProcessor` take `assetsUrl`, and resolve it when they're created, so a URL with a query or a fragment fails at once with `TypeError`. An output plays from its engine's media worker file, so it needs no option of its own. The build writes both files as one minified module each, with mediabunny's licence notice and no source maps, and the version is set at build time.
- **The worker's version is checked by `sdk-core`:** the SDK passes its package version as `packageVersion` to `exposeWorker` and `createWorkerClient`. A self-hosted worker from another version is refused with `WORKER_START_FAILED` before any call reaches it, naming the asset and both versions. There's no `version` method of our own.
- **No WebAssembly** in the first releases ([ADR 0001](0001-video-engines.md)).

### Content Security Policy

| Mode | Directives |
|---|---|
| Inline (default) | `worker-src blob:` |
| Self-hosted | `worker-src 'self'` |

- **Neither mode needs `'unsafe-eval'` or `'wasm-unsafe-eval'`.**
- **No media directives:** decoding and encoding through WebCodecs need no directive, and the SDK uses no `<video>` or `<audio>` element, so `media-src` needs nothing.
- **No image directives:** thumbnails reach the page as `ImageBitmap`s drawn into canvases, never as `blob:` or `data:` image URLs, so `img-src` needs nothing either.
- **mediabunny's own workers never start** ([ADR 0001](0001-video-engines.md)), so they need no directive.

### Tests

- **No network:** the end-to-end suites fail on any request to another origin, and assert that inline mode makes no request at all beyond the page and its scripts.
- **Self-hosted mode** runs the same fixtures with `assetsUrl` set and a CSP without `blob:`.
- **Crash recovery:** a browser test terminates the media worker during playback, and checks that a new one redraws the same frame from the sources' `Blob`s.
- **Messages:** a unit test checks that no message between the page and a worker carries a full-size `VideoFrame` or frame pixel buffer. The only media messages allowed are thumbnails, audio windows, peaks and an export's `Blob`.
- **Frames:** after seeking, playing, cancelling, failing and closing, each worker's open-frame counter returns to zero. This covers both `VideoFrame` and `AudioData`.
- **Cancelling an export** leaves the preview playing, and leaves no open frames in either worker.

## Alternatives considered

- **Decoding on the page:** every frame would be decoded and drawn on the main thread. [ADR 0031](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0031-platform-decoders-on-the-page.md) rule 1 forbids it for decoders that workers have.
- **Decoding in the worker and posting each `VideoFrame` to the page:** `VideoFrame`s can be transferred, but each frame would cross threads and be drawn and closed on the page. That spreads the close discipline over two threads. Every supported browser has `transferControlToOffscreen`, which avoids it.
- **One worker for everything:** cancelling a stuck export would terminate the worker that draws the preview, and the session would have to open every source again.
- **Audio in a worker, with an `AudioWorklet` reading a `SharedArrayBuffer`:** it needs the host to be cross-origin isolated, which audio-sdk also declined ([audio-sdk ADR 0002](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0002-workers-and-assets.md)). Windows of audio posted to the page need nothing from the host.

## Consequences

- **The main thread never parses, decodes, draws frames or encodes,** so the editor stays responsive with long and high-resolution footage.
- **Memory depends on queue lengths and frame size, not on the length of the footage.**
- **A worker crash loses no work:** the plan is on the page, and the sources are opened again from their `Blob`s.
- **The canvas belongs to the media worker once transferred,** so the page can't read or draw into it. Hit-testing and handles use the shared geometry instead, and tests read pixels back through the worker.
- **Audio crosses to the page,** so its window length is a trade-off between latency and the number of messages. A later record on playback sets it, together with how audio and video stay in sync ([ADR 0005](0005-playback-and-export.md)).
