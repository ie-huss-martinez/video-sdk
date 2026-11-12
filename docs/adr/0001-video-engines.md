# 0001. Video engines: mediabunny to read and write containers, WebCodecs to decode and encode

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-12, when decoding was built: a decoded frame's visible picture must fit the probe exactly, and its coded size may carry the decoder's alignment padding. Then, before export was built: what the encoding order gives in each engine, as measured, and how a configuration is chosen and proved. Then, when export's tests read audio back: decoded audio is placed by the stream, encoded audio is stamped by the stream, and AAC's priming is measured and trimmed.

## Context

The SDK opens untrusted videos: phone recordings, screen captures, downloads and uploads, inside other people's applications. Every file is hostile ([ADR 0012](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md), [ADR 0020](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0020-file-policy.md)), and engines never generate code or fetch anything ([ADR 0028](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0028-third-party-engines.md)).

Video brings four risks:

- **Container bombs.** A small file can declare a sample table with millions of entries, deep nesting, or more packets than its bytes could hold. The parser allocates and loops on what the file declares.
- **Codec bombs.** A decoder produces what the bitstream says, which can be larger than the container declared.
- **Memory.** One decoded 4K frame is about 33 MB. An editor that holds decoded frames rather than streaming them runs out of memory within seconds of footage.
- **Privacy.** Containers carry location, the recording device, creation times, extra tracks and cover art. An export that copies packets from a source can carry footage the user cut.

Video containers are much harder to read than audio ones. audio-sdk reads its formats with its own code, and its MP4 and Matroska readers refuse fragments and more than one track ([audio-sdk ADR 0001](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0001-audio-engines.md)). Video files nearly always have several tracks, are often fragmented, and need codec configuration records (`avcC`, `hvcC`, `vpcC`, `av1C`), composition offsets for B-frames and edit lists. Exporting also needs a muxer that writes all of that. Writing both ourselves would make a second, much larger body of hostile-input code.

Browsers ship hardened, sandboxed video and audio codecs through WebCodecs. [ADR 0013](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0013-browser-and-react-support.md) allows WebCodecs, and it's available in workers, so, under rule 1 of [ADR 0031](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0031-platform-decoders-on-the-page.md), decoding belongs in a worker, not on the page.

The application this SDK replaces played videos with a `<video>` element on the page, and exported by recording that element in real time with `MediaRecorder`. It parsed every file on the page, checked no limits, and its exports could be silent or truncated. This record replaces both paths.

The family reviewer approved this direction on 2026-11-12 as the family's decision for reading and writing containers. audio-sdk's ADR 0001 left its later lossy export to "its own ADR"; it can cite this one.

## Decision

The SDK reads containers into encoded packets and writes encoded packets into containers with **mediabunny**. It decodes and encodes with **WebCodecs**. Both run only in workers ([ADR 0002](0002-workers-and-assets.md)). The first releases bundle no other third-party runtime code and no WebAssembly.

### mediabunny, under ADR 0028

- **Version:** `mediabunny` **1.65.2**, pinned exactly, as a `devDependency` that the build bundles. Applications never install it.
- **Licence:** MPL-2.0, copyright "Vanilagy and contributors". The MPL is a file-level copyleft. Distributing its files unmodified inside an Apache-2.0 package is allowed, as long as the licence notices stay and recipients are told where the source is.
  - **`NOTICE`** credits it with its name, exact version, licence, copyright line and source, `https://github.com/Vanilagy/mediabunny/tree/v1.65.2`. The file is added by the pull request that first bundles mediabunny.
  - **Built chunks keep its `/*!` licence banner.**
  - **A build test** checks that the banner is present, and that the version in `NOTICE` equals the version in the lockfile.
- **Unmodified:** no patches (no `pnpm patch`), no vendored or forked copy. A fix goes upstream, or a new record replaces this one.
- **Where it may be imported:** only `src/adapters/mediabunny/` imports it, and only worker chunks contain it. The core, `react/`, `element/` and everything reachable from the `.`, `./react` and `./element` entries never do. A dependency-cruiser rule enforces this.
- **What the SDK uses, and nothing else:**
  - **reading:** `Input` with a `BlobSource`, its track metadata getters, and `EncodedPacketSink`;
  - **formats:** `Input` is given only `MP4`, `QTFF`, `MATROSKA` and `WEBM`, never `ALL_FORMATS`. HLS, MPEG-TS and audio-only formats are never offered to it;
  - **writing:** `Output` with `Mp4OutputFormat` or `WebMOutputFormat`, a `StreamTarget`, `EncodedVideoPacketSource`, `EncodedAudioPacketSource` and `setMetadataTags`.
- **What the SDK never uses:**
  - `UrlSource` or any source other than `BlobSource`;
  - the decoding sinks (`VideoSampleSink`, `CanvasSink`, `AudioSampleSink`, `AudioBufferSink`), the encoding sources (`VideoSampleSource`, `CanvasSource`, `AudioSampleSource`) and `Conversion`.

  Those run their own decoders and encoders, can start `blob:` workers of their own, and buffer frames beyond the SDK's bounds. The SDK drives WebCodecs itself instead, so it owns every queue and every `close()` ([ADR 0002](0002-workers-and-assets.md)).
- **No code from file data, and no network:**
  - **A build test** scans every worker chunk for `eval(` and `new Function`, and fails on either ([ADR 0028](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0028-third-party-engines.md)).
  - **A browser test** runs the end-to-end fixtures through probing, playback and export in a worker where `fetch`, `XMLHttpRequest`, `importScripts`, `Worker` and `URL.createObjectURL` throw. It fails if any is called. mediabunny 1.65.2 reaches `fetch` only through `UrlSource`. It starts workers only from the sinks and sources above, and from a timer helper that runs only when `window` exists, which a worker never has.
- **Upgrades:** one per pull request. Each one:
  - reviews the upstream changes to the demuxers and muxers the SDK uses;
  - runs the contract tests, the fuzz corpus and the end-to-end fixtures;
  - updates `NOTICE` in the same pull request.

  Dependabot's 7-day cooldown applies.

### Our own front check, before mediabunny reads anything

mediabunny 1.65.2 caps box and element nesting at 64. It doesn't cap the size of an index or the number of entries in a sample table, which it reads and loops over. So the worker checks every file with the SDK's own code first, through `sdk-core`'s windowed reader (`createWindowReader`, [ADR 0037](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0037-windowed-blob-reader.md)), never loading the file whole.

- **Format by signature,** never by file name or MIME type:
  - **ISOBMFF or QuickTime:** a leading `ftyp` box, or QuickTime's leading `moov`, `mdat`, `wide` or `free`;
  - **Matroska or WebM:** an EBML header whose `DocType` is `matroska` or `webm`.

  Anything else fails with `UNSUPPORTED_FORMAT` and never reaches mediabunny.
- **Structure:** the check walks only the top-level boxes or elements, and the few children named below, with a fixed depth limit. Every size is checked against the bytes that remain.
- **Index size:** the total size of the index is bounded before mediabunny parses it, and fails over the index limit, `maxIndexSize` ([ADR 0004](0004-video-limits.md)). For ISOBMFF that's `moov` plus every `moof`; for Matroska it's `SeekHead`, `Tracks`, `Cues` and `Tags`. So a sample table can never be larger than the index limit allows.
- **Edit lists:** mediabunny 1.65.2 honours only the first edit that maps media; it ignores further edits and any rate other than 1, with only a console warning. Other players honour them, so the SDK would show different footage than the user expects. An MP4 or MOV track whose `elst` has more than one edit mapping media, or a media rate other than 1, fails with `UNSUPPORTED_FORMAT` and `details.reason: "edit-list"`. A single leading empty edit is allowed.
- **Encryption:** encrypted tracks (`encv`, `enca`, a `pssh` box, or Matroska `ContentEncryption`) fail with `UNSUPPORTED_FORMAT`. The SDK never passes keys.

### The probe: walking every packet

Only then does the worker open the file with mediabunny.

- **Tracks:** the probe picks one video track, the container's primary one, or else the first. It picks one audio track, the first that WebCodecs can decode. Every track counts against the track limit, including those not used.
- **What it reads for each track:** the codec and its decoder configuration, the coded and display size, the rotation, and the time resolution.
- **Every packet:** the probe walks every packet of both tracks with `EncodedPacketSink` and `metadataOnly: true`, which reads sizes and timestamps without the packet data. From that walk it derives:
  - the packet count and total bytes, and the largest packet;
  - the first and last presentation timestamps, so the duration;
  - the smallest gap between consecutive presentation timestamps, so the peak frame rate;
  - the peak bitrate over one-second windows;
  - the positions of key packets, which seeking uses later.
- **The walk itself is bounded:**
  - it stops and fails as soon as a track has more packets than the limits allow: the duration limit times the frame-rate limit for video, and the duration limit times 1,000 for audio;
  - it runs under `withProcessingTime`.
- **Headers are compared, never trusted.** Duration, frame counts and sizes that a header claims are checked against what the walk found, and **the limits are checked against the larger of the two.**
- **Every limit is checked before any decoder is configured** ([ADR 0004](0004-video-limits.md)).
- **Malformed fails with a code:** `INVALID_VIDEO`, with `details` naming the format and what was wrong, never data from the file.

### Decoding: WebCodecs in the worker, with our own loops

- **Configuring:** `VideoDecoder` and `AudioDecoder` are configured from the track's decoder configuration, after `isConfigSupported`. A codec the browser can't decode fails with `UNSUPPORTED_CODEC` and `details.codec`.
- **Feeding:** the SDK's own loop reads packets from `EncodedPacketSink` and feeds the decoder. Both the decoder's queue and the decoded-frame queue are bounded, and every `VideoFrame` and `AudioData` is closed on every path ([ADR 0002](0002-workers-and-assets.md)).
- **Decoded audio is placed by the stream,** not by the decoder's timestamps alone. Each chunk keeps its own timestamp when that's within half a chunk of where the chunks before it end, and otherwise goes there; the first goes where its packet is. In the pinned image, WebKit's Opus decoder stamps every chunk away from its packet, and its AAC decoder stamps chunks seconds away for an MP4 with an edit list. Audio chunks follow each other without gaps, so the stream says where each belongs.
  - **The cost:** a real gap in a source's audio, a missing packet or a discontinuity, is closed rather than kept, so the audio after it plays early by the gap. Telling a gap from a misstamp would need to know which output belongs to which packet, and WebKit's AAC decoder swallows leading outputs, so a per-engine rule would itself be a guess. Such files are rare, and every chunk placed by the stream is counted in a test ledger.
- **The output is checked against the probe.** This is the video counterpart of rule 5 of ADR 0031.
  - **Video:** a decoded `VideoFrame` is closed and fails with `INVALID_VIDEO` when:
    - its visible picture is larger than the probe's coded size. The tolerance is zero;
    - its coded size exceeds the probe's by more than 128 pixels in either dimension. Decoders pad frames to their own alignment: Chromium decodes 1280 × 720 H.264 into 1280 × 738 frames and VP9 into 1344 × 720 ones, both with a 1280 × 720 visible picture;
    - its timestamp is outside the track's walked range.
  - **Audio:** an `AudioData` must have the configured sample rate and channel count, and at most the codec's largest frame:

    | Codec | Most frames per packet |
    |---|---|
    | AAC | 2,048 (HE-AAC) |
    | MP3 | 1,152 |
    | Opus | 5,760 |
    | Vorbis | 8,192 |
    | FLAC | 65,535 |
    | PCM | the packet's own size |

    Anything else fails with `INVALID_VIDEO`.
- **Errors are never shown:** a decode the browser rejects fails with `DECODE_FAILED` and `details.codec`, never with the browser's message.
- **Time:** every decode runs under `withProcessingTime`. A worker that doesn't settle in time is terminated ([ADR 0018](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0018-worker-rpc-protocol.md)).

### Encoding and writing: every export is re-encoded

- **No source packet is ever copied into an export.** Every frame and every audio sample in an output was decoded, composed and encoded again. So footage and audio the user cut, tracks the SDK didn't use, and metadata from a source can't survive into an export, by construction. Copying packets unchanged ("smart rendering") would be faster, but it's a later record with its own tests on exported bytes.
- **The codec is chosen by what the browser can encode,** with `VideoEncoder.isConfigSupported` and `AudioEncoder.isConfigSupported` in the worker, in this order:
  1. MP4 with H.264 and AAC;
  2. MP4 with H.264 and Opus;
  3. WebM with VP9 and Opus;
  4. WebM with VP8 and Opus.

  A host may ask for MP4 or WebM. If the browser can't encode either, the export fails with `UNSUPPORTED_CODEC`. A plan without audio writes no audio track.
- **What the order gives, as measured** in the pinned image's [capability matrix](../capabilities.md): every engine encodes H.264, VP8, VP9, AV1 and Opus, but only WebKit encodes AAC.
  - **In those builds, Chromium and Firefox export MP4 with H.264 and Opus,** and WebKit exports MP4 with H.264 and AAC.
  - **The order is decided at runtime, by probing the browser the user has,** not from this table. The image's Chromium is Playwright's open-source build, without proprietary codecs. Branded Chrome on Windows, macOS and ChromeOS, and Edge, generally encode AAC through the platform's encoders, so their users most likely get H.264 and AAC. Opus in MP4 is the fallback for builds without an AAC encoder, such as Chromium on Linux, and Firefox.
  - **MP4 with H.264 and Opus is kept ahead of WebM** when AAC isn't available. H.264 in MP4 is the most widely accepted video, by players, hardware decoders and upload sites, and Opus in MP4 is standardised. Some players, notably older Apple software, don't play Opus in MP4. A host that needs another choice can ask for WebM.
  - **The export summary names the container and both codecs** before the download ([ADR 0005](0005-playback-and-export.md)), so the user sees which they're getting.
  - **The export tests decode every exported file in the engine that made it,** so a combination that writes but doesn't play back fails a test.
- **How a configuration is chosen and proved:**
  - **The full configuration is checked,** not just the codec: the output's size, frame rate and bitrate for video, and the sample rate, channels and bitrate for audio.
  - **H.264 is High profile,** at the lowest level whose limits fit the output's size and frame rate: 4.0 for 1080p at 30 fps, and 5.1 for 4K at 30 fps. The codec string carries it, as `avc1.6400` plus the level.
  - **Opus is encoded at 48 kHz,** the rate Opus works at, whatever the plan's output rate. The mixer makes the export's audio at 48 kHz for it, and the summary shows the rate. AAC keeps the plan's rate.
  - **Audio chunks are stamped by their place in the stream.** In the pinned image, WebKit's AAC and Opus encoders give every chunk the timestamp and length of the audio it was encoded from, so several chunks share one time. Each chunk's time is set from its index instead: AAC-LC holds 1,024 samples, and Opus is set to 20 ms frames.
  - **Priming is trimmed by the file.** An encoder puts a few samples of delay before the audio: AAC's priming. The first chunk is stamped that many samples before zero, and the muxer writes an MP4 edit list that trims them, so the first sample heard is the plan's first. Opus records its pre-skip in its own header, which decoders apply, so its priming is 0. AAC's isn't recorded anywhere a decoder applies, so it's measured when the codec is proved: a tone burst at a known sample is encoded and decoded back, and the priming is where it comes back, less where it went in. The onset is taken above half the burst's level, because AAC smears a transient about a block early. WebKit measures 1,605 samples at 48 kHz. Where AAC can't be decoded back to measure it, AAC isn't proved, and the order goes on to Opus.
  - **A browser can claim a configuration it then fails to encode,** as with decoding. So before an export starts, the worker encodes one black frame and, with audio, one silent chunk with the chosen configuration. If either fails, it tries the next option in the order. Only when none works does the export fail with `UNSUPPORTED_CODEC`.
- **Writing:** the encoder's chunks go to `EncodedVideoPacketSource` and `EncodedAudioPacketSource`, awaiting each `add()` so the muxer's back-pressure holds. Their timestamps are presentation timestamps.
- **Metadata:** `setMetadataTags` writes only the fields the user set; nothing is read from a source into an export.

### The front check, the probe and the integration are hostile-input code

- **Bounded by construction:** every loop in our own code advances; every size is checked against the bytes that remain; nesting has a fixed depth limit; no allocation is sized from file data before the limits are checked.
- **Tested against garbage.** The same corpus runs through the front check and the probe in a worker:
  - every fixture truncated at every byte offset, and random bytes;
  - a property-based fuzz test with `fast-check` (MIT, a devDependency only) that mutates box and element headers and sample tables;
  - fixtures whose sample tables under-declare their packets, and files with very many tiny packets;
  - deep nesting, edit lists with several edits, and encrypted tracks.

  Each case settles within a fixed time with a result, `INVALID_VIDEO` or `UNSUPPORTED_FORMAT`. It never hangs, throws anything else, or crashes the worker.
- **Every upgrade of mediabunny runs this corpus.**
- **Fixtures are generated, never recordings:**
  - small files made by a committed script from synthetic sources: test patterns, frame counters and tones;
  - files encoded and muxed in the browser tests themselves.

## Alternatives considered

- **Our own readers and muxers, as in audio-sdk:** it keeps third-party code out, but video needs fragmented, multi-track ISOBMFF and Matroska with every codec configuration record, plus a muxer for both. That's a far larger parser and writer to keep correct and patched than audio's, for the same formats mediabunny already reads and writes.
- **FFmpeg compiled to WebAssembly (ffmpeg.wasm and similar demuxers):**
  - LGPL or GPL;
  - more than 25 MB;
  - threads that need the host to be cross-origin isolated, and `'wasm-unsafe-eval'` in every host's CSP;
  - a large native parsing surface, for formats the browser's own codecs already handle.
- **`mp4box.js` with `mp4-muxer` and `webm-muxer`:** `mp4box.js` (BSD-3-Clause) reads MP4 only, not Matroska. The two muxers are deprecated by their author: "This library is superseded by Mediabunny."
- **A `<video>` element and `MediaRecorder`, as in the replaced application:**
  - it parses on the page, which ADR 0031 rule 1 forbids for decoders that workers have;
  - it exports only in real time;
  - it checks no limits and isn't frame-accurate;
  - its audio capture is missing in some browsers.
- **mediabunny's sinks, sources and `Conversion`:** less code for us, but they own decoding and encoding. They can start their own `blob:` workers, and they buffer frames the SDK couldn't bound or close.

## Consequences

- **Every limit is checked before any decoder is configured,** from bounds the SDK's own code and its packet walk produced. A container or codec bomb never reaches a decoder.
- **One third-party engine, from a mostly single-maintainer project.** At the time of this record, its author wrote nearly all of it, and it releases every few days. Pinning, the per-upgrade review and the corpus keep upgrades deliberate. If it's abandoned or proves unsafe, a superseding record replaces it, for example with our own readers for the two container families.
- **Size:** mediabunny's whole minified bundle is about 187 kB gzipped. The worker chunks hold only the MP4 and Matroska demuxers and muxers. Their size budgets are measured and set with the first worker. None of it is in the main entries.
- **No WebAssembly:** the CSP needs no `'wasm-unsafe-eval'` ([ADR 0002](0002-workers-and-assets.md)).
- **Support depends on the browser** for each codec. The end-to-end capability matrix records which codecs decode and encode in Chromium, Firefox and WebKit, and every browser claim in these records is checked there before code relies on it.
- **Some files are refused:** files with several edits, encrypted files, and containers other than ISOBMFF and Matroska. The error says why.
- **Every export re-encodes.** It's slower than copying packets and loses a little quality, but nothing the user cut or didn't choose can leak.
