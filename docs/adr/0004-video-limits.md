# 0004. Video limits and session memory

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-12, when decoding was built: `maxDecodedSize` counts the decoders' alignment padding.

## Context

Every SDK enforces limits on untrusted files with `defineLimits` from `sdk-core`, extending `coreLimits`, and hosts change them through `filePolicy` ([ADR 0020](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0020-file-policy.md)). SDKs may change the core limits' defaults. The family keeps one name per concept.

Video's risks differ from the other SDKs':

- **Files are large but needn't be held.** Sources are read in slices from their `Blob`s ([ADR 0002](0002-workers-and-assets.md)), so a file's size costs time, not memory.
- **Decoded media is streamed,** never held whole ([ADR 0002](0002-workers-and-assets.md)). What a file costs in memory is its frame size times how many frames are alive at once, not its length:

  | Frame | Decoded, as RGBA |
  |---|---|
  | 1080p (1920 × 1080) | about 8.3 MB |
  | 4K (3840 × 2160) | about 33 MB |
  | 8K (7680 × 4320) | about 133 MB |
- **The decoder keeps frames of its own.** H.264, for example, may keep up to 16 reference frames, and the SDK can't see them.
- **The container's index is held by the demuxer,** and mediabunny doesn't bound it ([ADR 0001](0001-video-engines.md)).
- **Length costs time everywhere:** in the probe's packet walk, in seeking, and in export.

`pdf-sdk` and `image-sdk` already name a limit `maxImagePixels` (`IMAGE_TOO_LARGE`) for the pixels of an image. A video frame is a different concept: a cap on every decoded picture, checked again on every frame. So it gets its own name, as the family reviewer decided on 2026-11-12.

## Decision

### The limits

`videoLimits` is `coreLimits` with video defaults, plus eleven video limits, defined with `defineLimits` so that violations throw `VideoError`:

| Limit | Code | Unit | Default maximum | Default warning | Checked |
|---|---|---|---|---|---|
| `maxFileSize` (core) | `FILE_TOO_LARGE` | bytes | 4 GB | 1 GB | Each file, before it's read; and an export's estimated size, before it starts |
| `maxFiles` (core) | `TOO_MANY_FILES` | count | 20 | none | The sources in a session, on each open and insert |
| `maxDecodedSize` (core) | `DECODED_SIZE_TOO_LARGE` | bytes | 1 GB | 400 MB | What decoding one file can hold at once, from the probe (below) |
| `maxProcessingTime` (core) | `PROCESSING_TIME_EXCEEDED` | milliseconds | 120 s | none | Each probe, open, seek and thumbnail; and an export's progress (below) |
| `maxFramePixels` | `FRAME_TOO_LARGE` | pixels | 3840 × 2160 (8,294,400) | 2560 × 1440 (3,686,400) | Each video track's coded size, from the probe; every decoded frame; and the output, on `video.setOutput` |
| `maxFrameRate` | `FRAME_RATE_TOO_HIGH` | hertz | 120 | none | Each video track, from the packet walk; and the output |
| `maxDuration` | `DURATION_TOO_LONG` | milliseconds | 3 hours | 1 hour | Each file, from the packet walk; and the plan, on each command that lengthens it |
| `maxBitrate` | `BITRATE_TOO_HIGH` | count (bits per second) | 200 Mbit/s | none | Each file's peak over one-second windows, from the packet walk |
| `maxPacketSize` | `PACKET_TOO_LARGE` | bytes | 32 MB | none | Each packet, from the packet walk |
| `maxTracks` | `TOO_MANY_TRACKS` | count | 16 | none | Each file's tracks of every kind, from mediabunny's track list |
| `maxIndexSize` | `INDEX_TOO_LARGE` | bytes | 64 MB | none | Each file's index, from the front check, before mediabunny parses it ([ADR 0001](0001-video-engines.md)) |
| `maxChannels` | `TOO_MANY_CHANNELS` | count | 8 | none | Each audio track, from the probe; and the output |
| `maxSampleRate` | `SAMPLE_RATE_TOO_HIGH` | hertz | 192 kHz | none | Each audio track, from the probe; and the output |
| `maxSessionSize` | `SESSION_TOO_LARGE` | bytes | 512 MB | 256 MB | What the session and its workers keep beyond the decoders (below) |
| `maxClips` | `TOO_MANY_CLIPS` | count | 2,000 | none | The plan, on each command that adds clips |

- **The same names and codes as audio-sdk** for duration, channels, sample rate, session size and clips. That's one name per concept, for hosts that use both.
- **`maxFramePixels` is 4K by default.** Larger footage is uncommon in browsers. Each 8K frame is about 133 MB decoded, and phones' decoders and memory give out well before that. Hosts can raise it.
- **`maxTracks` is 16, not 8.** Phones record timed-metadata tracks alongside video and audio, and a file the SDK uses only two tracks of shouldn't fail on a third and fourth that it ignores.
- **`maxBitrate` uses the unit `count`.** `sdk-core`'s units are bytes, count, milliseconds, pixels and hertz ([ADR 0032](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0032-duration-format-and-hertz-unit.md)), and none is a rate of bits. The value is in bits per second. Messages format it with `Intl.NumberFormat`'s `megabit-per-second` unit. If `sdk-core` adds a rate unit, the limit adopts it.
- **`maxFrameRate` and `maxSampleRate` use `hertz`,** which is in `sdk-core` 0.3.0 ([ADR 0032](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0032-duration-format-and-hertz-unit.md)).
- **These are starting values, measured before the first release** by opening, playing and exporting files at each limit in the end-to-end suites, on all three engines. WebKit stands in for mobile Safari. If any is too high for phones, its default goes down, and the change gets its own record.

### How each limit is checked

- **Before any decoder is configured, against what the SDK read itself.**
  - **Front check:** `maxFileSize` and `maxIndexSize` are checked in the worker by the front check.
  - **Probe:** the frame, rate, duration, bitrate, packet, track, channel and decoded-size limits are checked by the probe ([ADR 0001](0001-video-engines.md)).
  - **Session:** only `maxFiles`, `maxSessionSize` and `maxClips` are the session's.
- **From the walk, never from a header alone.** Duration, frame rate, bitrate and packet size come from walking every packet. Where a header claims a value too, the larger of the two is checked. So a header can't lower a bound.
- **The frame rate is the most frames in any one-second window** of the walk. The smallest gap between two frames, which the walk also records, can be tiny in an ordinary file with a duplicated or reordered timestamp, so it's not used as a rate.
- **The walk can't run away.** It fails with `FRAME_RATE_TOO_HIGH` as soon as a video track has more packets than `maxDuration × maxFrameRate`. It fails with `DURATION_TOO_LONG` as soon as an audio track has more than 1,000 packets for every second of `maxDuration`. Both bounds hold even when the timestamps don't.
- **`maxDecodedSize` bounds one file's decoding,** not its length, because nothing is held whole. It's checked against the probe's coded size as (4 queued frames + 16 decoder reference frames + 1 on the canvas) × (coded width + 128) × (coded height + 128) × 4 bytes, plus one audio window.
  - The 128 pixels in each dimension are the most alignment padding a decoder may add to a frame ([ADR 0001](0001-video-engines.md)), so the limit counts what decoders really allocate.
  - A 4K file comes to about 763 MB, within the 1 GB default.
  - The 16 reference frames are the most H.264 allows. Other codecs allow no more, so this bounds what the decoder may hold, which the SDK can't measure itself.
- **Every decoded frame is checked again:** one larger than the probe's coded size, or over `maxFramePixels`, is closed and fails with `INVALID_VIDEO` ([ADR 0001](0001-video-engines.md)).
- **What's drawn is checked as well as what's opened.** `video.setOutput` checks the output's size, frame rate, sample rate and channels against the same limits, so an export can never encode more than they allow.
- **A failed check is specific.** It fails the open or insert with `details` naming the limit, its maximum and the actual value, and leaves the session's document as it was.
- **Warnings don't stop anything.** At or above a warning, the session adds one to the snapshot, and the editor shows it, such as "This video is large; playback may be slow on some devices."

### Time

- **`maxProcessingTime` applies to each probe, open, seek and thumbnail call.**
- **An export is long by nature,** so its time is bounded by the plan's length, which `maxDuration` bounds, and by progress. It fails with `PROCESSING_TIME_EXCEEDED` if no frame is encoded for `maxProcessingTime`. It can be cancelled at any time ([ADR 0005](0005-playback-and-export.md)).

### Session memory

What a session costs in memory isn't its sources, which stay `Blob`s, but what's derived from them:

- **The decoders.** Each source being decoded is bounded by `maxDecodedSize`. At most two sources decode at once in the media worker, at a cut between clips, and two more during an export.
- **The caches:** thumbnails, waveform peaks and audio windows scheduled ahead.

`maxSessionSize` counts the caches.

- **Thumbnails and audio windows are evicted, oldest first,** to stay under it. They can always be made again from the sources.
- **Peaks of every open source are kept,** because the timeline shows them. If they alone would exceed the maximum, an insert fails with `SESSION_TOO_LARGE`. Peaks cost a few kilobytes per minute, so in practice this is the protection against thousands of long sources, not a limit people meet.
- **Sources that only history refers to cost only their `Blob`s,** which the browser already holds. So history is never trimmed for memory, unlike audio-sdk's, where history holds decoded sources.

### Peak memory while opening

- **The probe holds packet metadata, not packet data:** one record per packet while it walks, about 1.3 million for a 3-hour, 120 fps track. Then it keeps only the key-packet index.
- **mediabunny holds the parsed index while a source is open.** Its in-memory form can be several times `maxIndexSize`.

The measurements before the first release open files at `maxIndexSize` and `maxDuration` on all three engines, so the defaults include these peaks.

### Other error codes

Alongside the limit codes and `sdk-core`'s own (`ABORTED`, `TIMEOUT`, `WORKER_*`, `UNSUPPORTED_ENVIRONMENT`), `VideoError` has:

| Code | When |
|---|---|
| `INVALID_VIDEO` | A file is malformed, its headers disagree with its packets, or it decodes to more than the probe allows ([ADR 0001](0001-video-engines.md)) |
| `UNSUPPORTED_FORMAT` | A container the front check doesn't recognise, an edit list or encryption the SDK refuses, or a file with no video track |
| `UNSUPPORTED_CODEC` | A codec the browser can't decode, or no container and codecs it can encode for an export |
| `DECODE_FAILED` | The browser failed to decode a probed and supported file |
| `ENCODE_FAILED` | The browser failed to encode during an export |
| `INVALID_COMMAND` | A command that doesn't apply to the plan ([ADR 0003](0003-clip-plan-document-model.md)) |
| `BUSY` | An export was requested while another is running ([ADR 0002](0002-workers-and-assets.md)) |

`details` hold the container, codec, limit or reason involved, never data from the file.

### Text

- **Error and warning text:** each code has text under `errors.<CODE>`, and each warning under `warnings.<limit>`, in `src/messages/en.ts` ([ADR 0019](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0019-message-catalogues.md)). A type check fails if any limit's code or warning is missing.
- **Formatting:**
  - durations use `sdk-core`'s `{name, duration}` format ([ADR 0032](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0032-duration-format-and-hertz-unit.md));
  - frame sizes are shown as width × height, and as megapixels when there's no width and height;
  - rates use `Intl` units.

## Alternatives considered

- **`maxImagePixels` for frames:** the family's existing name for an image's pixels. A frame limit is checked on every decoded picture of a stream, and an output size, which is a different concept, so it gets its own name and code.
- **`maxDecodedSize` as a file's total decoded size, as in audio-sdk and image-sdk:** for video it would be enormous for any ordinary file, about 750 GB for an hour of 1080p at 30 fps, and it isn't memory the SDK ever holds. Bounding what one file's decoding holds at once is the memory that matters.
- **Only `maxFileSize`:** a small file can declare millions of tiny packets or a 16K frame. The file's size says little about time or memory.
- **Trimming history for memory, as audio-sdk does:** history holds only `Blob`s here, so trimming it would free nothing.

## Consequences

- **A container or codec bomb is refused before decoding,** from bounds the SDK's own code read and walked, with an error that says which limit it hit.
- **Memory depends on frame size, not length,** so long recordings open as long as their frames fit.
- **The session needs `sdk-core` 0.3.0** for the `hertz` unit and the duration format.
- **The defaults are provisional** until the measurements on all three engines.
- **Hosts can raise or lower every limit** through `filePolicy`, and a misspelt name throws ([ADR 0020](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0020-file-policy.md)).
