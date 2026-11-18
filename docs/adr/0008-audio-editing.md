# 0008. Audio editing: clip controls in the editor, then audio tracks that stay in sync with the picture

- **Status:** Proposed
- **Date:** 2026-11-18

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
- **Clips on one track never overlap.** The reducer refuses a command that would make two overlap, with `audio-overlap`. Sound that should overlap goes on two tracks. So at most one clip per track sounds at any moment, which is the memory bound (section 6).
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
| `video.setAudioTrack { key, volumeDb, muted, followsVideo }` | Sets a track's volume, mute and whether it follows the video |
| `video.insertAudioClips { track, clips }` | Puts clips on a track, each at its `at` |
| `video.removeAudioClips { keys }` | Removes audio clips, leaving a gap |
| `video.moveAudioClips { keys, track, by }` | Moves audio clips by whole frames, to the same or another track |
| `video.trimAudioClip { key, start, end, at }` | Changes the source range an audio clip plays, and where it starts |
| `video.splitAudioClip { key, at, newKey }` | Splits an audio clip at a timeline frame |
| `video.detachAudio { keys, track, newKeys }` | Section 3 |

They follow ADR 0003's rules: strict, pure, refused with a `details.reason`, never silently corrected. `session.insertAudio(file, { track, at })` registers a source and executes `video.insertAudioClips`, as `session.insert` does for video.

### 5. The formats: `hm-video-plan` 2 and `hm-video-command` 2

- **Version 2 adds** `audioTracks`, each clip's `audioDetached`, and a source's `picture: { width, height, rotation } | null` and `audio: boolean` in place of its flat `width`, `height` and `rotation`. The command format adds the commands above and `audioKeys`.
- **A migration reads version 1:** no audio tracks, nothing detached, every source with a picture, and `audio: true` for every source, because version 1 never recorded it and a clip's sound was always allowed. `readVideoPlanDocument` reads both versions and `toVideoPlanDocument` writes 2. A version-1 reader refuses a version-2 document with `unknown-format-version`, as designed.
- **Both schemas ship,** `v1.schema.json` beside `v2.schema.json`. The version-1 vectors stay and run through the migration; version 2 gets its own, with hand-written cases for every new reason and generated ones for the time-axis edits, whose inverse must restore the plan.
- **Numbers stay exact.** `at` and `by` are frames, times are microseconds, and the volumes are floats that are copied, never computed. `gainAt`'s vectors keep their tolerance.
- **Version 2 is released once.** The core for sections 2 to 4 merges before any release that writes it.

### 6. Decoding, mixing and encoding

- **Decoding:** as now, in the workers, per window, for only the samples a window needs. Audio clips use the same reader as video clips' sound.
- **Mixing:** `mixWindow` sums every video clip that isn't detached and every audio clip, each through `gainAt`, with a track's volume and mute applied to its clips. It stays a pure function of the plan and a window, so windows still join without a seam, and playback and export still can't differ.
  - **The sum is clamped to −1…1,** and a sample that isn't finite counts as silence, so one bad sample from a decoder can't spoil a window. There's no limiter: it would carry state from window to window. A meter that warns when a mix clips can come later.
- **Encoding:** unchanged. One mixed track, AAC or Opus by ADR 0001's order, proved by encoding before the export starts.
- **Where the browser can't encode audio.** In the pinned image, all three engines have `AudioEncoder` in a worker; only WebKit encodes AAC, and all encode Opus ([capability matrix](../capabilities.md)). Outside it, a browser may have video encoders and no audio encoder; older Safari is reported to, which the image can't test.
  - `AudioEncoder` is required only when the plan has sound.
  - A plan with sound that no candidate can encode fails with `UNSUPPORTED_CODEC` and `details.track: "audio"`.
  - **Sound is never dropped silently.** The export dialog then says the browser can't encode sound and offers an export without it, which is `session.export({ audio: "omit" })`. The summary says "No sound" before the download.
- **Where the browser can't decode a file's audio,** the file opens with its picture, its source has `audio: null`, and the session adds a warning, instead of refusing the whole file. The same holds without `AudioDecoder`.
- **Privacy:** an audio file's tags and cover art are never read into an export, like a video's. The privacy test gains an audio source carrying marker strings.

### 7. Audio files

- **First: the containers the SDK already reads.** An MP4, M4A, MOV, WebM or Matroska file with no video track is accepted by `insertAudio`, through the same front check, with a probe that walks every audio packet. Its time starts at its first audio packet. A video file can be added as audio too, for its sound alone. Opening such a file as a video still fails with `UNSUPPORTED_FORMAT`.
- **Then MP3 and WAV,** which mediabunny reads, in a pull request of their own that amends ADR 0001: a signature and a bounded front check for each, their decoding measured in the capability matrix first, and the truncation, garbage and fuzz corpus for both. Ogg and FLAC follow the same way if asked for.
- **Recording a voice-over in the editor is out of scope.** It needs the microphone, a permission prompt and a host's `Permissions-Policy`, and gets its own record. Until then a voice-over is a file.

### 8. Limits

| Limit | Code | Default | Checked |
|---|---|---|---|
| `maxAudioTracks` (new) | `TOO_MANY_AUDIO_TRACKS` | 8 | The plan, on `video.addAudioTrack` and on reading a document |
| `maxClips` | `TOO_MANY_CLIPS` | 2,000 | Now counts video and audio clips together, including those a cut makes |
| `maxFiles`, `maxFileSize`, `maxDuration`, `maxBitrate`, `maxPacketSize`, `maxTracks`, `maxIndexSize`, `maxChannels`, `maxSampleRate` | as now | as now | An audio file, from its front check and its packet walk, before any decoder is configured |

- **What sounds at once is bounded by the model:** one clip on the video track and one per audio track, so nine at the default. A window holds each one's samples only while it's mixed: about 14 MB for nine sources at 192 kHz and eight channels, the limits' worst case.
- **Decoders:** at most one audio decoder per sounding clip, and the reader cache closes the least recently used beyond that. Video decoders stay at two ([ADR 0004](0004-video-limits.md)). Every `AudioData` is copied out and closed at once, as now.

### 9. Keep audio here; share the arithmetic in `sdk-core` later

**video-sdk doesn't depend on audio-sdk.**

- **Its core holds what video's rules forbid.** audio-sdk decodes each source whole into memory and mixes from whole buffers ([audio-sdk ADR 0003](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0003-clip-plan-document-model.md)). An hour of stereo audio at 48 kHz is about 1.4 GB decoded.
- **The units differ.** Its times are frames at the session's sample rate; ours are microseconds on the output's frame grid. Every call would convert, and rounding at that edge is where sync goes wrong.
- **Its readers would be a second parser.** It reads containers with its own code and decodes on the page; we read with mediabunny and decode in workers. Bundling both doubles the hostile-input code for the same files.
- **A dependency ties the releases.** During `0.x` a caret range stays in its minor, so every audio-sdk minor would force a video-sdk release, and a host with both would have to line them up or fail the one-copy rule ([sdk-core ADR 0047](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0047-one-copy-of-each-family-package.md)). Its model is also changing now.

**What's really shared is small and pure:** decibels to gain, the fade curves, the speaker-rule channel matrices, the resampler, and cutting a range out of a track of clips. By the family's rule of two consumers they belong in `sdk-core`, as the sequence helpers do ([sdk-core ADR 0042](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0042-timeline-sequence-helpers.md)). This repository proposes them there once audio-sdk's tracks exist to design against, and adopts them in a pull request of its own.

**The vocabulary is agreed now,** so hosts meet one: a track with a key, a volume, a mute and clips that have a start on the timeline; the same fade curves; the same limit name for the number of tracks.

### 10. The editor

- **The timeline** is `ui`'s `Timeline` ([ui ADR 0011](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0011-timeline.md)): the video track as `TimelineClips`, the waveform as a `TimelineLayer`, then one row per audio track with its header: mute, volume, "Moves with video edits", and remove.
- **Audio rows need two things `ui` doesn't have:** several clip tracks in one timeline, and clips with a start and gaps, moved by a drag along time. audio-sdk's tracks need the same, so it's `ui`'s to build. Until it does, the audio pull requests that draw rows wait; the model, mixing and export don't.
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
| 5 | `feat:` the inspector's clip panel: volume, mute and fades | |
| 6 | `feat:` the inspector's rotation, crop and fit, then the output and the metadata | |
| 7 | `fix:` `fileName` reaches the export dialog from `VideoEditor` and the element | |
| 8 | `fix:` audio encoder and decoder failures, as section 6 says, and the clamp | **0.2.0:** a clip's sound can be edited |
| 9 | `refactor:` `VideoTimeline` on `ui`'s `Timeline`, with the same keys | |
| 10 | `feat:` the waveform lane | **0.3.0:** the shared timeline |
| 11 | `feat!:` the model, the reducer and the formats' version 2, with the migration and vectors | |
| 12 | `feat:` mixing audio tracks, in playback and export | |
| 13 | `feat:` audio-only files from the containers already read, and `insertAudio` | |
| 14 | `feat:` audio rows, track headers and the tools, once `ui` has them | |
| 15 | `feat:` detach | **0.4.0:** music, voice-over and detached audio |
| 16 | `feat:` MP3 and WAV, amending ADR 0001 | **0.5.0** |

The inspector comes before the timeline's move to `ui` because it doesn't touch the timeline, and it's what the user asked for.

## Alternatives considered

- **Depend on audio-sdk's core:** section 9.
- **A flat list of audio clips that may overlap, with rows worked out by the view:** no refusals, but nothing bounds how many clips sound at once, a clip changes row when its neighbours move, and a track's volume and mute have nowhere to live.
- **Detached audio pinned to its video clip by an offset:** it follows moves without the reducer rewriting anything, but a pinned clip that reaches past its video clip can land on another clip of its track after any video edit. The reducer would have to refuse the video edit or move the audio to another track by itself. Following by track can't collide.
- **Audio tracks that never follow, or always follow:** never leaves a voice-over out of sync after the first cut; always cuts a hole in the music at every cut.
- **Audio clips placed in microseconds, off the frame grid:** finer than a frame, but the timeline would have two units, and `ui`'s is whole units. A frame is at most 42 ms at 24 fps. A finer offset can be added to a clip later without changing `at`.
- **Let audio extend the output with black frames:** a long music file would silently make a long video.
- **A limiter instead of a clamp:** it needs state across windows, so windows made separately would no longer join, and playback and export could differ.
- **A WebAssembly audio encoder where the browser has none:** ADR 0001 rules out WebAssembly, and it would need `'wasm-unsafe-eval'` in every host's CSP.
- **MP3 and WAV in the first audio release:** two more parsers' worth of hostile input before the model has shipped. The containers already read cost none.
- **Adding the fields to version 1:** strict readers refuse unknown fields, so it would break every version-1 reader without saying so in the version.

## Consequences

- **The question that prompted this is answered in 0.2.0,** with no model change: volume, mute and fades per clip.
- **Sound stays in sync by rules the reducer applies,** on a clip, on a following track and on a detached clip, and the conformance vectors hold every port to them.
- **The reducer grows the most:** every video command that changes the timeline's length also edits the following tracks, and each needs vectors and property tests. That's the cost of sync that can't be broken from the UI.
- **Clips on a track can't overlap,** so a crossfade is two tracks, and some commands are refused with `audio-overlap`. The UI clamps a drag at its neighbours.
- **An audio clip can't be nudged by less than a frame** in this version.
- **Free music doesn't follow cuts** unless its track is switched to. The switch's name and the track's header have to make that plain.
- **The formats move to version 2,** with a migration, and the summary of a source changes shape in the TypeScript API, so 0.4.0 is a breaking release.
- **Files with audio the browser can't decode now open,** silent and with a warning, rather than failing.
- **Work outside this repository:** `ui` needs audio rows (section 10); `sdk-core` gets the shared arithmetic later (section 9); and the name `maxAudioTracks` should match audio-sdk's.
- **ADR 0003, 0004, 0005 and 0007 are amended** when each part is built, as their own amendments record.
