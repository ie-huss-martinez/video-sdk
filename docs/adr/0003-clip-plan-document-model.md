# 0003. The clip plan: edits change a model in microseconds on a frame grid, and video is rendered on export

- **Status:** Accepted
- **Date:** 2026-11-12
- **Amended:** 2026-11-12, to match the model as built: a clip's end matches the grid within one microsecond, `video.restoreClips` and `video.setOutput` carry what undo needs, and a source's time begins at the probe's `start`. Then, when audio playback was built: that `start` is the video track's first timestamp.

## Context

The family requires every edit to be a serialisable command, run by a framework-agnostic session with undo and redo ([ADR 0008](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md), [ADR 0010](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0010-edits-as-commands.md)). [ADR 0029](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0029-session-store-and-history.md) puts what every session shares in `sdk-core`: `createStore`, `createHistory`, the `Reducer` type and `applyCommands`.

Video is far too large to edit directly. Decoded frames can't be kept at all ([ADR 0002](0002-workers-and-assets.md)), so edits can't change frames, and undo can't keep snapshots. The replaced application kept its state in fourteen React state variables, in floating-point seconds, with no model and no undo. Its fit and rotation applied to the preview but not to exports.

`audio-sdk` and `pdf-sdk` solved the same problem with a plan over immutable sources ([audio-sdk ADR 0003](https://github.com/ie-huss-martinez/audio-sdk/blob/main/docs/adr/0003-clip-plan-document-model.md), [pdf-sdk ADR 0003](https://github.com/ie-huss-martinez/pdf-sdk/blob/main/docs/adr/0003-page-plan-document-model.md)). Video has audio's shape: a sequence of pieces of immutable sources. But video has two clocks at once, frames and audio samples, and its sources can have variable frame rates.

## Decision

### The model

The session's document is a **clip plan** over immutable sources:

- **Sources:** each opened or inserted file, probed once and never modified ([ADR 0001](0001-video-engines.md)).
  - The session holds the file's `Blob` and a summary from the probe:
    - an id and the duration;
    - the video track's codec, coded and display size, rotation and frame rate;
    - the audio track's codec, sample rate and channel count, if it has one.
  - The core sees no decoded data and no DOM types, so tests can supply their own sources.
  - **A source's time begins at the probe's `start`:** the video track's earliest presentation timestamp. A clip's `start` and `end`, video frame bounds and waveform buckets all count from it, so a file whose timestamps don't begin at 0, such as one with a Matroska start offset, keeps its sound in line with its picture.
    - **Audio before the first frame is pre-roll,** and isn't played. Opus in WebM starts about 7 milliseconds before the first frame, for its codec delay, which the decoder drops. Counting from it made frame 0 sit 7 milliseconds into the source, so a seek to the first frame found nothing at or before it.
- **The plan:**
  - **`output`:** `{ width, height, frameRate, sampleRate, channels }`. `frameRate` is a rational `{ num, den }`, such as `{ num: 30000, den: 1001 }`;
  - **`clips`:** an ordered list, played back to back on one track;
  - **`metadata`:** title, description, artist, date and comment, the only fields an export writes ([ADR 0005](0005-playback-and-export.md)).
- **Each clip has:**
  - **`key`:** stable across edits, so selection and thumbnails follow a clip that moves;
  - **`source`, `start`, `end`:** the source and the range of it the clip plays, in source microseconds, with `start` inclusive and `end` exclusive;
  - **`volumeDb`** and **`muted`;**
  - **`fadeIn`, `fadeOut`:** audio fades, each `{ duration, curve: "linear" | "equalPower" }`, which reach silence on the clip's first and last sample, as in audio-sdk;
  - **`transform`:** `{ rotation: 0 | 90 | 180 | 270, crop, fit: "contain" | "cover" }`.
    - The rotation is added to the source's own rotation, which is always applied.
    - The crop is a rectangle in whole pixels of the rotated source.
    - The fit says how the cropped picture fills the output: whole and letterboxed, or filling it and cut at the edges.
- **The output comes from the first source** unless the host or user sets it with `video.setOutput`:
  - its display size after rotation, rounded down to even numbers, because encoders need them;
  - its frame rate, snapped to the nearest common rate (24, 25, 30 or 60, or their ×1000/1001 variants) when within 0.1%, and otherwise rounded to whole frames per second;
  - its audio's sample rate and channel count, or 48 kHz stereo when it has none.

### Time is integer microseconds, on the output's frame grid

- **Every time in the model is a whole number of microseconds,** the unit WebCodecs uses for timestamps. Seconds appear only at the edges: in the UI, through `Intl` formatting, and in events.
- **The timeline is a grid of output frames.** Output frame `n` starts at `frameTime(n) = round(n × 1,000,000 × den ÷ num)` microseconds. Positions in commands that refer to the timeline, such as `at`, `to` and `deleteRange`'s bounds, are frame indexes.
- **Every clip covers a whole number of output frames.**
  - A clip's length on the timeline is `frames = round((end − start) × num ÷ (1,000,000 × den))`. Its `end` must equal `start + frameTime(frames)`, within one microsecond. When a clip is split, each half is rounded to whole microseconds, so for a rate such as 30000/1001 a half's length can differ from `frameTime(n)` by one. The timeline counts frames, not microseconds, so that difference never builds up.
  - The reducer rejects a clip that doesn't fit the grid. The UI snaps every edit to the grid before building a command.
  - A clip's place on the timeline is the sum of the frames before it. It's derived and never stored, so it can't disagree with the clips, and no rounding error builds up along the timeline.
- **Which source frame each output frame shows:**
  - output frame `n` of a clip shows the source frame whose presentation timestamp is the largest at or before the matching source time;
  - so sources with variable or different frame rates play at the output's rate, repeating or skipping source frames as needed;
  - the probe's walk guarantees every source time has such a frame ([ADR 0001](0001-video-engines.md)).
- **Audio follows the same times.** A clip's audio runs from sample `floor(start × rate ÷ 1,000,000)` of its source, for as many samples as the clip lasts at the output's sample rate. Sources at another rate are resampled to the output's rate in the worker, by the same resampler for playback and export ([ADR 0005](0005-playback-and-export.md)).
- **Pure helpers in `core/model`** compute frame times, clip offsets and which clip and source time a timeline frame falls in. When `sdk-core`'s shared sequence helpers arrive, as agreed for the family, the model adopts them in a pull request of its own.

### Commands

Commands are plain, structured-cloneable data, named `video.*`:

| Command | Changes |
|---|---|
| `video.insertClips { at, clips }` | Inserts clips at a timeline frame, splitting the clip there if needed |
| `video.removeClips { keys }` | Removes clips |
| `video.restoreClips { entries, remove }` | Removes the clips named in `remove`, then puts clips back at their indexes, with every field as it was, replacing any clip with the same key. The inverse of most edits |
| `video.deleteRange { start, end, keys }` | Removes a range of timeline frames, trimming or splitting the clips it touches |
| `video.trimClip { key, start, end }` | Changes the source range a clip plays |
| `video.splitClip { key, at, newKey }` | Splits a clip at a timeline frame into two |
| `video.moveClips { keys, to }` | Moves clips to a timeline position |
| `video.setVolume { keys, volumeDb }` | Sets the volume of clips |
| `video.setMuted { keys, muted }` | Mutes or unmutes clips |
| `video.setFade { key, edge, duration, curve }` | Sets a clip's audio fade in or fade out |
| `video.setTransform { keys, transform }` | Sets the rotation, crop and fit of clips |
| `video.setOutput { output, clips }` | Sets the output's size, frame rate, sample rate and channels. Undo passes `clips` to put the clips back as they were |
| `video.setMetadata { field, value }` | Sets one metadata field |

- **The reducer is `sdk-core`'s `Reducer<VideoPlan, VideoCommand>`:** a pure function that applies one command and returns its inverse. The session applies sequences with `applyCommands`, which returns the inverses in the order undo needs.
- **Commands carry everything the reducer needs,** so it stays pure. The keys of new clips are in the command (`newKey` in `video.splitClip`, `keys` in `video.deleteRange`), and the session generates them before it executes.
- **Invalid commands throw `VideoError` with `INVALID_COMMAND`.** Examples:
  - a range outside its source, or a clip off the frame grid or shorter than one frame;
  - a crop outside the rotated source, or smaller than 2 × 2 pixels;
  - an unknown key.

  The UI clamps what people enter before building a command. The reducer never silently corrects a command.
- **Edits keep clips valid.** A trim that leaves a fade longer than its clip shortens the fade, and a rotation that changes a source's orientation keeps its crop inside it. The inverse is `video.restoreClips`, with the clip's full previous state, so undo restores both.
- **Changing the output keeps every clip on the grid.** `video.setOutput` keeps every clip's start. When the frame rate changes, it moves each clip's end to the nearest frame of the new grid that fits its source, and shortens fades to fit, all in the same command. A clip too near the end of its source for even one frame of the new grid moves its start back just enough for that frame, and only a source shorter than one output frame is refused. So the plan is on the grid after every command, and the inverse, which carries the previous output and clips, restores both.
- **Sources are registered, not carried in commands.** `session.insert(file, { at })`:
  1. probes the file and checks it against the file policy ([ADR 0004](0004-video-limits.md));
  2. opens it in the media worker ([ADR 0002](0002-workers-and-assets.md));
  3. then executes `video.insertClips` with the source's id.

  Commands never carry bytes or frames.
- **A result that arrives late applies nothing it shouldn't.** An insert resolves `at` against the plan as it is when its command executes, clamped to the end. A probe or thumbnail for a source the session has since closed is discarded.

### The session

- **The store is `sdk-core`'s `createStore`.** The snapshot holds:
  - the status, the sources (summaries only), the plan, and the selection, which is a timeline range kept outside the history as view state;
  - `canUndo`, `canRedo` and whether history was trimmed;
  - the export in progress, if any, with its progress;
  - warnings and the last error.
- **The history is `sdk-core`'s `createHistory`,** with `group()` for gestures that make several commands. Dragging a trim handle, dragging a crop frame or typing into a metadata field is one undoable step each.
- **Undo uses inverse commands, never snapshots of frames.** A step costs a few hundred bytes. Sources that only history refers to stay registered, as their `Blob`s, until the step is dropped.
- **The playhead isn't in the session.** It moves with every frame during playback. `VideoOutput` has its own small store, also from `createStore`, with its state (stopped, playing or paused) and a `position()` read from the playback clock ([ADR 0005](0005-playback-and-export.md)). Play and pause take the family's `play-pause` shortcut ([ADR 0030](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0030-tools-and-keyboard-shortcuts.md)).
- **Events:** each command emits an anonymous event with its type and outcome for the host's `onEvent`, with durations in seconds. Events never carry file names, frames, audio or metadata values.

### The ports

| Port | Does | Default adapter |
|---|---|---|
| `VideoEngine` | Probes and opens files; builds thumbnails and waveform peaks; closes sources | The media worker ([ADR 0001](0001-video-engines.md), [ADR 0002](0002-workers-and-assets.md)) |
| `VideoOutput` | Plays a plan from a position into an attached canvas, with audio, and reschedules on changes | The media worker and Web Audio on the page ([ADR 0005](0005-playback-and-export.md)) |
| `VideoProcessor` | Exports a plan to a file, with progress and cancellation | The export worker ([ADR 0005](0005-playback-and-export.md)) |

- **The session depends only on the ports.** Unit tests run it against fakes, without a browser, and every adapter passes its port's contract tests.
- **Only `features/`, `react/` and `element/` import `@hussmartinez/ui`** ([ADR 0036](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0036-ui-as-a-dependency-of-the-sdks.md)). The model, the session and the ports never do.

### What the model doesn't cover

These are extensions, each with its own record. The commands above stay valid with each of them:

- **Overlays,** such as text, images and picture-in-picture: a separate list keyed by the clips or the timeline, as `pdf-sdk` keeps annotations beside its page plan.
- **Separate audio tracks,** such as music or a voiceover: a list of audio clips with their own timeline positions, in audio-sdk's shape.
- **Transitions and speed changes:** a transition would join two clips over a range of frames, and a speed would change how a clip's source time maps to the grid.

## Alternatives considered

- **Edit frames directly, with snapshots for undo:** impossible at video sizes. One second of 1080p is about 250 MB decoded.
- **Floating-point seconds:** what the replaced application used. Positions drift, an edit can't name an exact frame, and two clips can disagree about where one ends.
- **Integer frames, as in audio-sdk:** video has two clocks, frames and audio samples, and sources with variable frame rates. Microseconds name both exactly, and the frame grid keeps every edit on a whole frame.
- **Source frame indexes for clip ranges:** variable frame rates make "frame 120" of a source a different time from its rate × 120. A source's frame indexes would also need the whole packet index to resolve, while microseconds compare directly with timestamps.
- **The playhead in the session snapshot:** a snapshot per frame would re-render every subscriber during playback.

## Consequences

- **Edits are instant and cost almost no memory:** they change a small plan, and video is decoded only to show or export it.
- **Every edit lands on a whole output frame,** and audio follows the same times, so playback and export agree on where every clip begins.
- **Undo is consistent with `audio-sdk`'s and `pdf-sdk`'s,** because all three use `sdk-core`'s history.
- **The session needs `sdk-core`'s store and history** (0.2.0 and later) and, for the limits, its `hertz` unit (0.3.0, [ADR 0004](0004-video-limits.md)).
- **Command definitions become public API,** tracked in the API report ([ADR 0009](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0009-features-as-tools.md)).
