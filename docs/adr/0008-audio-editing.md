# 0008. Audio editing: clip controls in the editor, then audio tracks that stay in sync with the picture

- **Status:** Accepted. The audio rows of the timeline depend on an amendment to [ui ADR 0011](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0011-timeline.md), in section 10; the headless core and the inspector don't
- **Date:** 2026-11-18
- **Amended:** 2026-11-18, with 8b as built: sound that can't be decoded or encoded. Earlier, with item 8 split in three, the export's result as built (8a), and the date rule moved to version 2 of the formats, which sdk-core ADR 0045 requires. Earlier, with the releases as they went out: 0.2.0 after the clip panel, and each later release one number on; the clock's anchor and the element join the plan. Earlier, with the review's rulings: the mix follows [audio-sdk ADR 0006](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0006-multitrack.md) where a user would notice a difference, why `maxAudioTracks` is 8, and `ui`'s lanes are designed for both SDKs.

## Context

A user of the video editor asked on 2026-11-18 why the audio of a video can't be edited. The answer is in two halves.

### What the SDK does with audio today (0.1.2)

- **One audio track per file is used:** the first whose codec mediabunny recognises (`src/adapters/mediabunny/tracks.ts`). Other audio tracks are ignored. A file whose chosen audio track the browser can't decode is refused whole, with `UNSUPPORTED_CODEC` (`decoder-support.ts`), and a file with no video track is refused with `UNSUPPORTED_FORMAT`.
- **Audio belongs to its clip.** A clip has `volumeDb` (−96 to +24 dB), `muted`, `fadeIn` and `fadeOut` ([ADR 0003](0003-clip-plan-document-model.md)), set by `video.setVolume`, `video.setMuted` and `video.setFade`, which are in `hm-video-command` 1. Because a clip's sound is the same source range as its picture, split, trim, move and delete keep it in sync by construction.
- **Playback and export mix it the same way.** `mixWindow` (`src/core/audio/mix.ts`) resamples each clip, mixes it to the output's channels and scales it by `gainAt`; the media worker and the export worker both call it through `mixAudioWindow` ([ADR 0005](0005-playback-and-export.md)).
- **Every export re-encodes it:** decoded, mixed, and encoded as AAC, or as Opus at 48 kHz where the browser has no AAC encoder. No source packet is copied ([ADR 0001](0001-video-engines.md)). A plan gets an audio track when any clip's source has audio, even when every clip is muted.
- **Tests prove it on exported bytes:** the audio of a cut part is absent, each flash is within a frame of its tone across cuts, and muting during playback leaves no gap (`test/export-privacy.browser.test.ts`, `test/playback.browser.test.ts`).
- **The editor shows almost none of it.** Its only audio control is the mute tool (`M`). The inspector that [ADR 0007](0007-editor-shell.md) gives the volume and fades to was never built, and neither was the waveform lane, though the engine already makes peaks. So the commands exist and nothing in the editor sends them.

So the first half of the answer is a missing panel, not a missing engine.

### What it can't do at all

There's one track. The plan has no place for sound that isn't a clip's own: music, a voice-over, or a clip's audio moved apart from its picture. ADR 0003 left "separate audio tracks" to a record of its own. This is it.

Three gaps in the code matter to it:

- **The mix isn't clamped.** One clip at +24 dB already leaves the range encoders take; several tracks summed will do it routinely.
- **A missing audio encoder is reported badly.** `chooseCandidate` fails with `UNSUPPORTED_ENVIRONMENT` when `AudioEncoder` doesn't exist, even for a plan with no audio, and when no audio codec encodes, it fails with `UNSUPPORTED_CODEC` and `details.track: "video"`.
- **`ui`'s `TimelineClips` lays clips back to back** (`{ key, length }`, [ui ADR 0011](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0011-timeline.md)). An audio track has gaps.

### Forces

- **Memory:** decoded media is streamed, never held whole, and what decodes at once is bounded ([ADR 0004](0004-video-limits.md)).
- **Hostile input:** every new kind of file is new parsing, with its front check, probe and fuzz corpus ([ADR 0001](0001-video-engines.md)).
- **Formats:** adding a field to a strict format is a breaking change, with a new version and a migration ([sdk-core ADR 0045](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0045-portable-formats-and-conformance-vectors.md)). So the plan's new shape should be decided once.
- **audio-sdk is getting several tracks,** in another agent's hands. Hosts that use both SDKs should meet one vocabulary.

## Decision

### 1. First, the editor sends the commands the core already has

No model or format change. The inspector of ADR 0007 is built, starting with the selected clips' panel: volume (a slider in decibels, with a number field), mute, fade in and fade out (a length and a curve), then rotation, crop and fit. A drag or a run of typing is one undo step, through `group()`. The timeline gets its waveform lane. This alone answers the question that prompted this record, so it ships first.

### 2. Audio tracks

The plan gains **`audioTracks`**, an ordered list. The video track stays as it is.

- **A track:** `{ key, volumeDb, muted, followsVideo, clips }`.
- **An audio clip:** `{ key, source, start, end, at, volumeDb, muted, fadeIn, fadeOut }`.
  - `source`, `start`, `end`, the volume, mute and fades mean what they mean on a video clip.
  - **`at` is the output frame the clip starts on.** It covers a whole number of output frames, by the same rule as a video clip, so every edit of every track lands on one grid, and the timeline's unit stays the frame.
- **Clips on one track never overlap.** The reducer refuses a command that would make two overlap, with `clips-overlap`, audio-sdk's token for the same rule. A track's clips are kept in time order. Sound that should overlap goes on two tracks. So at most one clip per track sounds at any moment, which is the memory bound (section 6).
- **A video clip gains `audioDetached`.** When it's set, the clip's own sound isn't played. It's separate from `muted`, so unmuting a clip can never double a sound that now lives on a track.
- **Keys are unique across video and audio clips,** so `video.setVolume`, `video.setMuted` and `video.setFade` take either kind.
- **The video track sets the length.** Audio past the last frame isn't played or exported, and the timeline shows it dimmed. Music longer than the picture doesn't add black frames.
- **Sources may have no picture.** A source's summary has `video: … | null` and `audio: … | null`. A video clip needs a picture (`no-picture`), and an audio clip or a detach needs sound (`no-audio`).

### 3. Sync

- **A clip's own audio:** in sync by construction, as today.
- **Detaching** (`video.detachAudio`) puts each chosen clip's sound on a named audio track as an audio clip with the same source range, at the clip's place, with its volume, mute and fades, and sets `audioDetached`. Nothing is heard to change. From then on the sound is trimmed, moved, faded and deleted on its own.
- **A track with `followsVideo` gets every edit of the video track's time.** Each video command changes the timeline in one of three ways, and the reducer applies the same change to every following track, in the same command:

  | The video track | A following audio track |
  |---|---|
  | Loses a range: `video.removeClips`, `video.deleteRange`, a trim inward | Loses the same range: clips inside it go, clips across its edges are cut, and what's after moves earlier |
  | Gains a range: `video.insertClips`, a trim outward | Opens the same gap: a clip across the point is cut there, and what's after moves later |
  | Moves a range: `video.moveClips` | The sound under the moved clips is cut out and put down where they land |

  Each is one change of the time axis applied to the whole track, so it can't make two clips overlap, and sound that was under a frame stays under it. `video.splitClip` moves nothing.
- **A track without `followsVideo` stays where it is.** Music keeps playing under a cut.
- **The defaults:** the track a detach creates follows; a track made for an added file follows when it's added as a voice-over and doesn't when it's added as music. The track's header has the switch, named for what it does: "Moves with video edits".
- **Cuts need keys.** A command that can cut audio clips carries `audioKeys`, generated by the session, as `video.deleteRange` carries `keys`. A pure helper says how many a command needs.
- **Undo** is one internal inverse, `video.restoreAudio`, carrying the tracks' previous clips, beside `video.restoreClips`.
- **`video.setOutput` regrids audio clips** as it does video clips. Each track is laid out again in order: a clip starts on the new grid's nearest frame to its old time, or right after the clip before it if that's later, and keeps at least one frame.

### 4. Commands

| Command | Changes |
|---|---|
| `video.addAudioTrack { key, index, followsVideo }` | Adds an empty track |
| `video.removeAudioTracks { keys }` | Removes tracks and their clips |
| `video.setAudioTrack { key, volumeDb?, muted?, followsVideo? }` | Sets the fields given, at least one |
| `video.insertAudioClips { track, clips }` | Puts clips on a track, each at its `at` |
| `video.removeAudioClips { keys }` | Removes audio clips, leaving a gap |
| `video.moveAudioClips { keys, by, track? }` | Moves audio clips by whole frames, and to another track if one is named |
| `video.trimAudioClip { key, start, end }` | Changes the source range an audio clip plays. The sound stays where it is on the timeline: moving `start` moves `at` by the same amount |
| `video.splitAudioClip { key, at, newKey }` | Splits an audio clip at a timeline frame |
| `video.detachAudio { keys, track, newKeys }` | Section 3 |

They follow ADR 0003's rules: strict, pure, refused with a `details.reason`, never silently corrected. `session.insertAudio(file, { track, at })` registers a source and executes `video.insertAudioClips`, as `session.insert` does for video.

### 5. The formats: `hm-video-plan` 2 and `hm-video-command` 2

- **Version 2 adds** `audioTracks`, each clip's `audioDetached`, and a source's `picture: { width, height, rotation } | null` and `audio: boolean` in place of its flat `width`, `height` and `rotation`. The command format adds the commands above and `audioKeys`.
- **A migration reads version 1:** no audio tracks, nothing detached, every source with a picture, and `audio: true` for every source, because version 1 never recorded it and a clip's sound was always allowed. `readVideoPlanDocument` reads both versions and `toVideoPlanDocument` writes 2. A version-1 reader refuses a version-2 document with `unknown-format-version`, as designed.
- **Both schemas ship,** `v1.schema.json` beside `v2.schema.json`. The version-1 vectors stay and run through the migration; version 2 gets its own, with hand-written cases for every new reason and generated ones for the time-axis edits, whose inverse must restore the plan.
- **Numbers stay exact.** `at` and `by` are frames, times are microseconds, and the volumes are floats that are copied, never computed. `gainAt`'s vectors keep their tolerance.
- **Version 2 is released once.** The core for sections 2 to 4 merges before any release that writes it.
- **The date must be a real calendar date in version 2,** `YYYY-MM-DD`, or empty: the schema gives it a pattern, and the reducer refuses another with `INVALID_COMMAND` and `details.reason: "invalid-date"`. It's the only date a container stores, and the export writes nothing for other text. Version 1 accepts any text, and sdk-core ADR 0045 requires a reader to accept exactly what its schema does, so the rule can't tighten version 1: the migration turns a version-1 date that isn't one into "", which no export ever wrote anyway. Until version 2, the inspector refuses one, and the export summary says when a plan's date won't be written (8c).

### 6. Decoding, mixing and encoding

- **Decoding:** as now, in the workers, per window, for only the samples a window needs. Audio clips use the same reader as video clips' sound.
- **Mixing:** `mixWindow` sums every video clip that isn't detached and every audio clip, each through `gainAt`, with a track's volume and mute applied to its clips. It stays a pure function of the plan and a window, so windows still join without a seam, and playback and export still can't differ.
  - **Tracks sum at unity,** with no scaling by their number: adding an empty track mustn't change how the others sound.
  - **The order of the sum is fixed:** the video track's clips first, then the audio tracks from the top, each track's clips in time order, added in double precision. So every engine and every port adds in the same order, as audio-sdk's mix does.
  - **Clipping: clamp, measure and say so,** which is audio-sdk's policy. The sum is clamped to full scale, −1…1, in playback and export alike. Nothing limits or normalises on its own: a limiter changes the sound without being asked, and carries state from window to window, so windows made separately would no longer join.
  - **The export reports what it clamped.** `VideoProcessor.export` and `session.export` resolve `{ blob, container, size, peakDb, clippedFrames }` instead of a `Blob`, with audio-sdk's names: the mix's peak before clamping, `-Infinity` for silence, and how many sample frames had a sample over full scale. The export dialog shows it when anything clipped, with how far over the peak was. That's a breaking change to both calls.
  - **As built (8a):** the clamp is in `mixWindow`, so playback and export clamp alike, and an export meters its windows as it mixes them. `session.export(options)` exports the plan as it is when the call starts, through the session's `processor`, which `createVideoSession` now takes, as audio-sdk's does; without one it throws `TypeError`, as audio-sdk's does, rather than the `UNSUPPORTED_ENVIRONMENT` first proposed, because a missing processor is the host's mistake, not the browser's. The editor's session exports through the editor's own processor, made on the first export. An export emits an `export` event with its outcome.
  - **The session's warnings take the family's shape** in the same release, as audio-sdk's do: `{ type: "limit", limit, actual, source? }`, with `videoWarningText(messages, warning)` for their text. Warnings that aren't limits, such as a file whose sound couldn't be decoded (8b), are other `type`s.
  - **A sample that isn't finite counts as silence,** so one bad sample from a decoder can't spoil a window or the peak.
  - **Mute** means what it does in audio-sdk: a muted clip or track isn't heard and isn't exported, and it's part of the plan, undone like any edit. There's no solo in this version. If one is added, it takes audio-sdk's rule: a track is audible when it isn't muted and either no track is soloed or it is.
- **Encoding:** unchanged. One mixed track, AAC or Opus by ADR 0001's order, proved by encoding before the export starts.
- **Where the browser can't encode audio.** In the pinned image, all three engines have `AudioEncoder` in a worker; only WebKit encodes AAC, and all encode Opus ([capability matrix](../capabilities.md)). Outside it, a browser may have video encoders and no audio encoder; older Safari is reported to, which the image can't test.
  - `AudioEncoder` is required only when the plan has sound.
  - A plan with sound that no candidate can encode fails with `UNSUPPORTED_CODEC` and `details.track: "audio"`.
  - **Sound is never dropped silently.** The export dialog then says the browser can't encode sound and offers an export without it, which is `session.export({ audio: "omit" })`. The summary says "No sound" before the download.
- **Where the browser can't decode a file's audio,** the file opens with its picture, its source has `audio: null`, and the session adds a warning, instead of refusing the whole file. The same holds without `AudioDecoder`.
- **As built (8b):** the media worker's open check says whether the sound decodes rather than refusing the file. The engine then keeps the source's probe without sound, so playback, peaks and export all read it as silent, and its info names the codec in `unplayableAudio`, an optional field, so a host's own engine needn't set it. The session warns with `{ type: "audioUndecodable", source, codec }`. An export asks for `AudioEncoder` only for a plan with sound; it fails with `UNSUPPORTED_CODEC` and `details.track: "audio"` when the picture encodes and the sound doesn't, and `VideoExportJob.audio` and `session.export`'s `audio` take `"omit"`. The export dialog then says the browser can't save the sound, and its main button becomes "Export without sound"; its summary says "No sound" for that export. Every engine in the test image has both audio codecs, so the tests run the SDK's own worker code in a worker with them removed.
- **Privacy:** an audio file's tags and cover art are never read into an export, like a video's. The privacy test gains an audio source carrying marker strings.

### 7. Audio files

- **First: the containers the SDK already reads.** An MP4, M4A, MOV, WebM or Matroska file with no video track is accepted by `insertAudio`, through the same front check, with a probe that walks every audio packet. Its time starts at its first audio packet. A video file can be added as audio too, for its sound alone. Opening such a file as a video still fails with `UNSUPPORTED_FORMAT`.
- **Then MP3 and WAV,** which mediabunny reads, in a pull request of their own that amends ADR 0001: a signature and a bounded front check for each, their decoding measured in the capability matrix first, and the truncation, garbage and fuzz corpus for both. Ogg and FLAC follow the same way if asked for.
- **Recording a voice-over in the editor is out of scope.** It needs the microphone, a permission prompt and a host's `Permissions-Policy`, and gets its own record. Until then a voice-over is a file.

### 8. Limits

| Limit | Code | Default | Checked |
|---|---|---|---|
| `maxAudioTracks` (new) | `TOO_MANY_AUDIO_TRACKS` | 8 | The plan, on each command that adds a track, and when a session loads a plan. A reader checks shapes; the session checks limits |
| `maxClips` | `TOO_MANY_CLIPS` | 2,000 | Now counts video and audio clips together, including those a cut makes |
| `maxFiles`, `maxFileSize`, `maxDuration`, `maxBitrate`, `maxPacketSize`, `maxTracks`, `maxIndexSize`, `maxChannels`, `maxSampleRate` | as now | as now | An audio file, from its front check and its packet walk, before any decoder is configured |

- **`maxAudioTracks` keeps its name, and is 8 where audio-sdk's `maxTracks` is 16.**
  - **The name:** `maxTracks` here already counts the tracks in a file, and the plan has a video track too, so "tracks" alone would be ambiguous.
  - **The number:** audio-sdk mixes from sources it already holds decoded. Here every sounding clip is decoded as it plays, in the same workers and at the same time as the picture, so each track costs a decoder and its share of every window. Eight covers a voice-over, music and effects beside the clips' own sound. Hosts can raise it.
- **What sounds at once is bounded by the model:** one clip on the video track and one per audio track, so nine at the default. A window holds each one's samples only while it's mixed: about 14 MB for nine sources at 192 kHz and eight channels, the limits' worst case.
- **Decoders:** at most one audio decoder per sounding clip, and the reader cache closes the least recently used beyond that. Video decoders stay at two ([ADR 0004](0004-video-limits.md)). Every `AudioData` is copied out and closed at once, as now.

### 9. Keep audio here; share the arithmetic in `sdk-core` later

**video-sdk doesn't depend on audio-sdk.**

- **Its core holds what video's rules forbid.** audio-sdk decodes each source whole into memory and mixes from whole buffers ([audio-sdk ADR 0003](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0003-clip-plan-document-model.md)). An hour of stereo audio at 48 kHz is about 1.4 GB decoded.
- **The units differ.** Its times are frames at the session's sample rate; ours are microseconds on the output's frame grid. Every call would convert, and rounding at that edge is where sync goes wrong.
- **Its readers would be a second parser.** It reads containers with its own code and decodes on the page; we read with mediabunny and decode in workers. Bundling both doubles the hostile-input code for the same files.
- **A dependency ties the releases.** During `0.x` a caret range stays in its minor, so every audio-sdk minor would force a video-sdk release, and a host with both would have to line them up or fail the one-copy rule ([sdk-core ADR 0047](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0047-one-copy-of-each-family-package.md)). Its model is also changing now.

**What's really shared is small and pure:** decibels to gain, the fade curves, the speaker-rule channel matrices, the resampler, and cutting a range out of a track of clips. By the family's rule of two consumers they belong in `sdk-core`, as the sequence helpers do ([sdk-core ADR 0042](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0042-timeline-sequence-helpers.md)). This repository proposes them there once audio-sdk's tracks exist to design against, and adopts them in a pull request of its own.

**Where a user or a host would notice a difference, this record follows [audio-sdk ADR 0006](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0006-multitrack.md):**

| | audio-sdk | Here |
|---|---|---|
| A track | A key, a gain, mute, and clips in time order that never overlap, refused with `clips-overlap` | The same |
| A clip's place | `at`, stored, in sample frames | `at`, stored, in output frames |
| Clip edits | Never move another clip; a trim leaves the sound where it is | The same |
| The mix | Unity sum in plan order, in double precision, then a clamp | The same, with the video track's clips first |
| Clipping | Clamp, report `peakDb` and `clippedFrames`, no limiter | The same |
| Mute | In the plan, and exported as heard | The same |
| Fade curves | `linear`, `equalPower` | The same |

**Where they differ, on purpose:**

- **`volumeDb`, from −96 to +24 dB, not `gainDb` from −120 to +120.** Version 1 of our formats already names and bounds a clip's volume, and tracks use the same name and range as clips.
- **No master gain, track names or solo** in this version. Each would be a field in a later format version, in audio-sdk's shape.
- **Closing gaps:** audio-sdk asks for it with time commands and a Ripple switch. Here it follows the video track, per track, through `followsVideo` (section 3), because the video track is back to back and every edit of it changes time.
- **The limit's name and number,** as section 8 says.

### 10. The editor

- **The timeline** is `ui`'s `Timeline` ([ui ADR 0011](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0011-timeline.md)): the video track as `TimelineClips`, the waveform as a `TimelineLayer`, then one row per audio track with its header: mute, volume, "Moves with video edits", and remove.
- **Audio rows need what `ui` doesn't have yet,** and `ui` is designing it as an amendment to its ADR 0011, for audio-sdk and this SDK together. What this SDK needs from it:
  1. **several lanes in one timeline,** with one playhead: the video lane, back to back as now, and audio lanes under it, each with a header that doesn't scroll with time;
  2. **clips with a start,** so an audio lane has gaps, and audio past the video's end can be shown dimmed;
  3. **a layer per lane,** for each lane's waveform;
  4. **moving a clip by its body,** along time and to another audio lane, reported once when the drag ends, and never into the video lane;
  5. **lanes that redraw together:** an edit of the video lane moves the clips of every following lane in the same render, and a detach adds a clip to an audio lane under its video clip, with focus going to it.

  The pull request that draws audio rows comes after that `ui` release. The model, mixing, export and the inspector don't wait for it.
- **Every drag has keys and a single-pointer way,** as ADR 0007 requires: an audio clip moves with `Alt+Left` and `Alt+Right` by a frame, and with Shift by a second; fades are fields in the inspector as well as handles on the clip.
- **Names come from the catalogue:** "Audio clip 2 of 3 on track 1, 0:04.00 to 0:09.20, muted". Nothing from a file is shown as HTML, and events carry counts, never names.
- **Tools:** `video.add-audio`, which opens a picker and asks "Music" or "Voice-over", and `video.detach-audio`. Scrubbing stays silent.

### 11. The order of the work

Each line is one pull request. A release is cut where shown.

| # | Pull request | Release |
|---|---|---|
| 1 | `docs:` this record | |
| 2 | `docs:` the README: what the package is, how to use it, the CSP, and no "being bootstrapped" | |
| 3 | `build:` `ui` 0.11 and its `sdk-core`, together (one copy) | |
| 4 | `refactor:` `hm-text` on the editor's root, without our own font rules ([ui ADR 0010](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0010-opt-in-text-root.md)) | |
| 5 | `feat:` the inspector's clip panel: volume, mute and fades, heard as a drag moves | **0.2.0:** a clip's sound can be edited |
| 6 | `feat:` the inspector's rotation, crop and fit, then the output and the metadata | |
| 7 | `fix:` `fileName` reaches the export dialog from `VideoEditor` | |
| 8a | `fix!:` `session.export`, the clamp, the export's clipping report, and the family's warning shape | |
| 8b | `fix:` audio encoder and decoder failures, and an export without sound where it can't be encoded, as section 6 says | |
| 8c | `fix:` the export summary says when the plan's date won't be written | |
| 9 | `fix:` the clock's anchor is renewed at once when the audio clock's offset jumps, amending [ADR 0006](0006-frame-scheduler.md) | **0.3.0:** the whole inspector, and exports that say what they did to the sound |
| 10 | `refactor:` `VideoTimeline` on `ui`'s `Timeline`, with the same keys | |
| 11 | `feat:` the waveform lane | **0.4.0:** the shared timeline |
| 12 | `feat:` the `<hm-video-editor>` element, which the family requires of every SDK and `./element` doesn't have yet | |
| 13 | `feat!:` the model, the reducer and the formats' version 2, with the migration and vectors | |
| 14 | `feat:` mixing audio tracks, in playback and export | |
| 15 | `feat:` audio-only files from the containers already read, and `insertAudio` | |
| 16 | `feat:` audio rows, track headers and the tools, after `ui`'s release with lanes | |
| 17 | `feat:` detach | **0.5.0:** music, voice-over and detached audio |
| 18 | `feat:` MP3 and WAV, amending ADR 0001 | **0.6.0** |

The inspector comes before the timeline's move to `ui` because it doesn't touch the timeline, and it's what the user asked for.

**As released:** 0.2.0 went out after item 5, with the README, `ui` 0.11 and `hm-text`, so the clip panel reached the application at once. Items 6 to 8 moved to 0.3.0, and each later release moved up one. Two items joined the table from review: the clock's anchor (item 9), and the element (item 12).

## Alternatives considered

- **Depend on audio-sdk's core:** section 9.
- **A flat list of audio clips that may overlap, with rows worked out by the view:** no refusals, but nothing bounds how many clips sound at once, a clip changes row when its neighbours move, and a track's volume and mute have nowhere to live.
- **Detached audio pinned to its video clip by an offset:** it follows moves without the reducer rewriting anything, but a pinned clip that reaches past its video clip can land on another clip of its track after any video edit. The reducer would have to refuse the video edit or move the audio to another track by itself. Following by track can't collide.
- **Audio tracks that never follow, or always follow:** never leaves a voice-over out of sync after the first cut; always cuts a hole in the music at every cut.
- **Audio clips placed in microseconds, off the frame grid:** finer than a frame, but the timeline would have two units, and `ui`'s is whole units. A frame is at most 42 ms at 24 fps. A finer offset can be added to a clip later without changing `at`.
- **Let audio extend the output with black frames:** a long music file would silently make a long video.
- **A limiter instead of a clamp, or scaling the mix by the number of tracks:** both change levels nobody asked to change, and a limiter needs state across windows, so windows made separately would no longer join. Clamping and reporting leaves the decision visible, and matches audio-sdk.
- **A WebAssembly audio encoder where the browser has none:** ADR 0001 rules out WebAssembly, and it would need `'wasm-unsafe-eval'` in every host's CSP.
- **MP3 and WAV in the first audio release:** two more parsers' worth of hostile input before the model has shipped. The containers already read cost none.
- **Adding the fields to version 1:** strict readers refuse unknown fields, so it would break every version-1 reader without saying so in the version.

## Consequences

- **The question that prompted this is answered in 0.2.0,** with no model change: volume, mute and fades per clip.
- **Sound stays in sync by rules the reducer applies,** on a clip, on a following track and on a detached clip, and the conformance vectors hold every port to them.
- **The reducer grows the most:** every video command that changes the timeline's length also edits the following tracks, and each needs vectors and property tests. That's the cost of sync that can't be broken from the UI.
- **Clips on a track can't overlap,** so a crossfade is two tracks, and some commands are refused with `clips-overlap`. The UI clamps a drag at its neighbours.
- **An audio clip can't be nudged by less than a frame** in this version.
- **Free music doesn't follow cuts** unless its track is switched to. The switch's name and the track's header have to make that plain.
- **The formats move to version 2,** with a migration, and the summary of a source changes shape in the TypeScript API, so 0.5.0 is a breaking release. So is 0.3.0, for `export`'s result.
- **Files with audio the browser can't decode now open,** silent and with a warning, rather than failing.
- **Work outside this repository:** `ui` builds the lanes (section 10); and `sdk-core` gets the shared arithmetic later (section 9).
- **ADR 0003, 0004, 0005 and 0007 are amended** when each part is built, as their own amendments record.
