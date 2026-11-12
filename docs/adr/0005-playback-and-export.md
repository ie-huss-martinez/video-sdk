# 0005. Playback with audio as the clock, and export with progress, cancellation and nothing but the edit

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-12, when export was built: how audio is interleaved, what the file is collected in, the metadata's date and creation time, and what loads when. Earlier, when audio playback was built: the context runs at the device's rate. Earlier, when audio mixing was built: the resampler's kernel and its table, exact-position evaluation so windows join without a seam, and the order of resampling, channel mixing and gain.

## Context

[ADR 0002](0002-workers-and-assets.md) puts decoding and drawing in the media worker and exporting in the export worker. It leaves two questions open: how video stays in sync with audio during playback, and how an export runs.

- **Playback has two outputs on two threads.** Frames are drawn in the media worker. Audio can only be heard through an `AudioContext` on the page, which runs on the audio hardware's own clock. Neither `performance.now()` nor a frame counter keeps time with it over minutes, and people notice audio and video drifting apart by a few tens of milliseconds.
- **Export must match the preview** and contain nothing else. The replaced application exported by playing the video aloud in real time and recording it:
  - pausing truncated the file;
  - a background tab dropped frames;
  - fit and rotation applied only to the preview;
  - its audio was silent in some browsers.
- **Privacy depends on what an export contains,** not on what the editor shows. Exports must carry no footage or audio the user cut, nothing from another clip, and no metadata from a source.

## Decision

### Playback

#### The clock: the `AudioContext`

- **When the plan has audio, the page's `AudioContext` is the master clock.**
  - It's created lazily, on the first play, which is a user gesture, as browsers require.
  - It runs at the device's own rate, and the worker resamples to it. WebKit in the pinned image opens a context at a requested 48 kHz whose clock then barely moves, and resampling in the worker costs little.
- **Video follows the clock; audio never waits for video.** The playhead is `VideoOutput.position()`, read from the same clock ([ADR 0003](0003-clip-plan-document-model.md)).
- **A plan without audio uses `performance.now()` as its clock.**

#### Audio: windows scheduled ahead

- **The media worker produces audio in windows of 250 milliseconds,** already mixed:
  - it decodes each clip's audio;
  - it resamples it to the context's rate;
  - it applies each clip's volume, mute and fades through the pure `gainAt(clip, time)`, which export uses too;
  - it mixes to the output's channels with Web Audio's speaker rules, as audio-sdk does.
- **The page schedules each window** as an `AudioBufferSourceNode` started at an exact context time. It keeps at least two windows, half a second, scheduled ahead.
- **Seeking, editing or pausing** stops every scheduled node and schedules again from the new position. Windows already made for unchanged parts of the plan are reused from the cache ([ADR 0004](0004-video-limits.md)).
- **Resampling is our own code,** a windowed-sinc resampler in the core, deterministic and shared by playback and export. `OfflineAudioContext` doesn't exist in workers.
  - **The kernel** is a Blackman-windowed sinc with 16 zero crossings each side. When downsampling, its cutoff drops to the output's Nyquist, so nothing above it folds back.
  - **It's read from a table,** made once per pair of rates at 512 entries per input sample, and each tap is interpolated linearly between two entries, as bandlimited-interpolation resamplers do. There's no trigonometry per tap, and on each side of a position the table index steps by a whole sample with the same interpolation weight. In Node, whose V8 is Chromium's, 10 seconds of mono takes about 30 ms from 44.1 to 48 kHz (about 300× real time), 33 ms from 48 to 44.1 kHz (about 300×) and 55 ms from 96 to 48 kHz (about 180×), across runs on a desktop. Evaluating the kernel directly took about 390, 440 and 770 ms (26×, 23× and 13×). `scripts/bench-resample.ts` measures it.
  - **Each output sample is evaluated at its exact position** in the source, from the clip's start and the two rates, rather than streamed through a filter with state. So windows made separately, in any order, join without a seam, and a window is the same whether playback or export makes it.
  - **Channels are mixed after resampling,** by a matrix of Web Audio's speaker rules for mono, stereo, quad and 5.1, and one to one for other layouts. Then `gainAt` scales each sample.

#### Video: frames drawn against the clock

- **The page tells the media worker how to read the clock.**
  - At play, and every 250 milliseconds while playing, it sends one mapping from `AudioContext.getOutputTimestamp()`: a context time, the `performance.now()` time it corresponds to, and the output latency.
  - The output latency is the context's `outputLatency` where the browser reports it, and its `baseLatency` otherwise.
  - So the worker knows which media time is being heard now, without shared memory.
- **The worker draws on each animation frame.** It uses `requestAnimationFrame` in the worker where the browser has it, and a timer at the output's frame rate where it doesn't.
  - It reads the media time from the mapping, and draws the newest decoded frame whose time is at or before it.
  - It closes the frames it skipped.
  - It keeps decoding ahead, within the queue bounds ([ADR 0002](0002-workers-and-assets.md)).
- **When decoding can't keep up, frames are dropped,** never audio paused. `VideoOutput`'s snapshot counts dropped frames, so the editor can suggest a smaller preview.
- **At a cut between clips,** the worker starts decoding the next clip from its key packet before the cut is reached, so the first frame of the next clip is ready in time.
- **In a background tab,** animation frames stop and audio continues. When the tab is visible again, the worker draws the frame the clock has reached.

#### Seeking and scrubbing

- **Seeking** decodes from the key packet before the target, using the probe's key-packet index ([ADR 0001](0001-video-engines.md)), and draws the target frame.
- **Requests that arrive while a seek runs are coalesced,** so only the latest is drawn ([ADR 0002](0002-workers-and-assets.md)).
- **Scrubbing is silent** in the first releases.

#### No frame from the wrong clip

- **Every drawn frame is the one the plan names.**
  - The worker draws a frame only if its source and time match the clip that the plan places at the clock's position.
  - Each source has its own decoders, and every decoder is reset on seek.
  - So no frame from another clip, a previous seek or a previous plan can be drawn.
- **An edit during playback** reschedules audio and makes the worker check the next frame against the new plan.

#### The sync test

A generated "flash and beep" fixture has white flash frames and short tones at known times, in several clips cut together. Two tests use it:

- **Playback, in all three engines:** each flash is drawn within one output frame of when its tone is heard. For the flash, that's the worker's draw time in `performance.now()`; for the tone, its scheduled context time, mapped through the clock mapping and output latency. The check is made after cuts, seeks and an edit during playback.
- **Export:** the exported file is decoded, and each flash frame must be within one frame of its tone's first sample. This also catches encoder priming, such as AAC's, and offsets written by the muxer.

### Export

#### What an export runs

`session.export({ container, quality, signal, onProgress })` sends the plan and the sources' `Blob`s to the export worker ([ADR 0002](0002-workers-and-assets.md)).

1. **Checks.** The worker chooses the container and codecs by capability ([ADR 0001](0001-video-engines.md)). The session checks the estimated size, the output's bitrate times its duration, against `maxFileSize` before anything starts ([ADR 0004](0004-video-limits.md)).
2. **Video, frame by frame on the output's grid.**
   - For output frame `n`, the worker finds the clip and source time ([ADR 0003](0003-clip-plan-document-model.md)). It decodes forward through each clip from its first key packet, which is more efficient than seeking.
   - It composes the frame on an `OffscreenCanvas` at the output size through `composeFrame(plan, n)`: the source's rotation, the clip's rotation, crop and fit, and black where the fit leaves bars.
   - It makes a `VideoFrame` with timestamp `frameTime(n)`, encodes it, and closes both frames.
3. **Audio, by samples on the same timeline.** It's decoded, resampled and mixed with the same `gainAt` and resampler as playback, then encoded in chunks whose timestamps count samples from zero.
4. **Writing.**
   - The encoders' chunks are written by mediabunny into a `StreamTarget` ([ADR 0001](0001-video-engines.md)).
   - MP4 puts its index at the end (`fastStart: false`), so the file is written in one pass and never held twice. The header's final sizes are patched where the muxer writes them.
   - The worker collects the written parts into the output `Blob`.

#### As built

- **Audio is interleaved with the video:** after each output frame, the audio is mixed and encoded up to that frame's end, in windows of a tenth of a second. A muxer holds packets of one track until the other catches up, so encoding all the video first would hold the whole video in memory.
- **The file is collected in parts** as the muxer writes them, through a `StreamTarget`. MP4 without fast start writes in order, then goes back to patch the media box's size in its header: the patch is copied into the parts it covers. The parts become the `Blob`.
- **Metadata:** the title, description, artist and comment are written when set. The date is written only when it's a calendar date, `YYYY-MM-DD`, because containers store dates, not free text. mediabunny writes the current time as the creation time unless told not to, so it's always set to none.
- **The queues:** the encoders' queues hold at most 8 frames or chunks, and at most 16 encoded chunks wait for the muxer before the encoders wait.
- **What loads when:** `createVideoProcessor` is in the root entry, small. The export runner and the export worker load on the first export, from lazy chunks. Each processor has its own export worker, which stops after `sdk-core`'s idle timeout.
- **The time limit is a stall:** `maxProcessingTime` runs from the last progress, so a long export isn't cut off, and one that stops encoding fails with `PROCESSING_TIME_EXCEEDED`.

#### One compose step for the preview and the export

`composeFrame` and `gainAt` are pure functions of the plan, in the core. The media worker draws the preview through them, and the export worker draws and mixes the export through them. So what the editor shows and plays is what the file contains, and the replaced application's preview-only fit and rotation can't recur.

#### Encoding settings

- **Key frames** every 2 seconds.
- **Latency mode:** `quality`.
- **Hardware acceleration:** left to the browser.
- **Bitrate:** set from a quality preset (`low`, `medium`, `high`) and the output's pixels and frame rate. `medium` is the default.

#### Back-pressure and memory

- **The encoder's queue is bounded at 8 frames** ([ADR 0002](0002-workers-and-assets.md)), and every write to the muxer is awaited. So export runs as fast as the encoder allows, never in real time, and without playing anything aloud.
- **Memory is the queues plus the output:** the collected `Blob` parts. The browser may keep them on disk. The size check against `maxFileSize` bounds them.

#### Progress, cancellation and failure

- **Progress:** `onProgress` reports encoded frames out of the total, at most ten times a second. The session's snapshot carries the same progress, so the editor can show it.
- **Cancelling.** The signal stops the loop, closes every open frame, closes the decoders and encoders, and cancels the output. The call rejects with `ABORTED`, and no partial `Blob` is returned. If the worker doesn't settle within `sdk-core`'s cancel timeout, it's terminated ([ADR 0018](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0018-worker-rpc-protocol.md)). The preview keeps playing either way.
- **Stalling:** an export that encodes no frame for `maxProcessingTime` fails with `PROCESSING_TIME_EXCEEDED` ([ADR 0004](0004-video-limits.md)).
- **A browser encoding error** fails with `ENCODE_FAILED` and `details.codec`, never the browser's message.

#### After an export

- **Export never downloads anything itself.** The editor shows a summary before the download, as the standards require ([STANDARDS](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#ux)). The summary gives the duration, resolution, frame rate, container and codecs, the size, and the metadata the file will carry. The host's `onExport` can take the `Blob` instead.

### What an export contains, and nothing else

- **Only the plan's frames and audio.** Every output frame and sample is decoded, composed and encoded again; no source packet is copied ([ADR 0001](0001-video-engines.md)). Footage and audio the user trimmed, split off or deleted, unused tracks, chapters, subtitles and cover art can't reach the file.
- **Only the metadata the user set.**
  - The plan's title, description, artist, date and comment are written with `setMetadataTags`.
  - Nothing is read from a source into an export: no location, recording device or creation time.
  - Fields that the container itself requires, such as its brand and timescales, are written with fixed values, never values taken from a source.
- **Tests read the exported bytes,** not what the editor shows:
  - **Cut footage:** a fixture whose every frame shows its own frame number as a pattern is cut, trimmed and split. The exported file is decoded, and it must contain exactly the frames the plan names, in order.
  - **Cut audio:** tones with distinct frequencies in the cut parts must be absent from the exported audio.
  - **Metadata:** a fixture whose source carries a location, a device name and marker strings in its metadata and extra tracks is exported. The bytes must contain none of them, and only the fields the user set, plus the container's required ones. Any tag mediabunny writes by default is turned off, or documented here by a superseding record.
  - **Frames between clips:** two sources with distinct colour patterns are cut together. Every exported frame and every played frame must come from its own clip's source, including the first frame after each cut, after a seek and after an edit.

## Alternatives considered

- **`performance.now()` as the only clock:** the audio hardware's clock drifts from it, so audio and video would drift apart over a long timeline.
- **Video as the master clock, adjusting audio to match:** audio would have to be stretched or skipped, which people hear far more readily than a dropped frame.
- **Audio in an `AudioWorklet` reading shared memory from the worker:** it needs the host to be cross-origin isolated ([ADR 0002](0002-workers-and-assets.md)).
- **Exporting by playing in real time and recording, as the replaced application did:** it's slow and audible, it fails in background tabs and when paused, and it records what the screen shows rather than what the plan says.
- **MP4 with its index at the start (`fastStart: "in-memory"`):** better for streaming the file later, but the whole output is held in memory until the end. Moving the index is a later option for hosts that need it.
- **Copying source packets where nothing changed ("smart rendering"):** faster, but a copied packet can carry what the user cut, and metadata in its sample entries. It's a later record, with the same tests on exported bytes.

## Consequences

- **Audio and video stay within a frame of each other,** measured in all three engines and in exported files, and audio never stutters for video.
- **Exports are faster than real time** where the encoder is, silent, and work in a background tab.
- **What the preview shows is what the file contains,** because both go through the same `composeFrame` and `gainAt`.
- **Nothing the user cut or didn't choose can leak into an export,** and the tests check the bytes, not the editor.
- **Every export re-encodes,** with a small loss of quality, and is slower than copying would be.
- **The browser's capabilities set the limits of playback:** a device that can't decode 4K in real time drops frames, which the snapshot reports. The capability matrix records which browsers play which sizes smoothly.
