# 0006. The frame scheduler: playback's clock, frame ownership, dropping and seeking

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

[ADR 0002](0002-workers-and-assets.md) has the media worker draw the preview into a canvas the page transferred to it, and keeps decoded frames in that worker. [ADR 0005](0005-playback-and-export.md) makes the page's `AudioContext` the master clock, sends the worker a mapping from it every 250 milliseconds, and draws the newest frame at or before the clock. Neither says how the scheduler works frame by frame. This record does, before the code, so that `VideoOutput` ([ADR 0003](0003-clip-plan-document-model.md)) is built to it.

The decoder is built ([ADR 0001](0001-video-engines.md)): `decodeVideoFrames` lends each frame to a consumer, in presentation order, and closes it when the consumer settles. At most 4 decoded frames wait, and at most 8 packets.

Measured in the pinned browser image, in Chromium, Firefox and WebKit:

- **`requestAnimationFrame` exists in dedicated workers** in all three, at the display's rate (about 60 a second headless).
- **An `AudioContext` starts `suspended`** until a user gesture lets it run, as browsers' autoplay rules require. `getOutputTimestamp()` exists in all three and reports zeros while suspended. Headless, `outputLatency` reports 0 and `baseLatency` 0 to 10 milliseconds.
- **A context created at another sample rate**, such as 44.1 kHz, keeps it in all three.
- **Drawing a `VideoFrame` into a worker's 2D `OffscreenCanvas`** worked in Firefox and WebKit. In Chromium, a synthetic test with a frame made from an empty canvas threw, which says nothing about decoded frames; the capability matrix confirms decoded frames before the code relies on it.

## Decision

### One clock per output

`VideoOutput` keeps one clock that maps media time, in output microseconds on the plan's timeline, to the page's `performance.now()`. It has two sources:

- **The audio clock,** when the plan has audio and the `AudioContext` is running. The page reads `getOutputTimestamp()`, adds the output latency (`outputLatency`, or `baseLatency` where that's 0 or missing), and sends the worker an **anchor**: "media time *M* is heard at performance time *P*". It sends a new anchor at play, at every seek, and every 250 milliseconds while playing, so the worker follows the audio hardware's clock as it drifts from `performance.now()`.
- **The performance clock,** when the plan has no audio, or audio can't start. The anchor is set at play and at every seek, and media time advances with `performance.now()`.

Both sides compute media time the same way, `M + (now − P) × 1,000` microseconds, from the latest anchor. So the page's playhead, `VideoOutput.position()`, and the frames the worker draws agree, without a message per frame.

**Autoplay.** `play()` creates the `AudioContext` lazily and calls `resume()`. If it isn't running when `resume()` settles, playback continues on the performance clock with no sound, and the output's snapshot reports `audio: "blocked"`. The next `play()`, from a user gesture, tries again. The editor can then show why there's no sound, and tests run headless.

### Frames never leave the worker, and the consumer owns the wait

- **The media worker owns the canvas and every frame** ([ADR 0002](0002-workers-and-assets.md)). The page never receives a `VideoFrame`, so the close discipline stays in one thread.
- **The scheduler is the decoder's consumer.** For each frame `decodeVideoFrames` lends it, the scheduler works out the frame's time on the plan's timeline:
  - source time = timestamp − the probe's `start` ([ADR 0003](0003-clip-plan-document-model.md));
  - within the clip, time on the timeline = the clip's offset + (source time − the clip's `start`).

  It then **waits, inside the consumer, until the clock reaches that time,** then draws it, then returns, and the decoder closes it.
- **So back-pressure comes for free.** While the scheduler waits for the next frame's time, the decoder holds at most 4 frames ahead and stops feeding packets. Memory stays at the queue bounds, at any length of footage.
- **Drawing** goes through the pure `composeFrame(plan, frame)`, shared with export ([ADR 0005](0005-playback-and-export.md)): the source's and clip's rotation, the crop and the fit, at the stage's size times the device pixel ratio. A frame is drawn on the worker's `requestAnimationFrame`, at most once per animation frame.

### Dropping late frames

- **A frame whose time is already past** by more than one output frame when it arrives is closed without being drawn, and counted in the snapshot's `droppedFrames`. The scheduler doesn't wait for it.
- **Audio never waits for video** ([ADR 0005](0005-playback-and-export.md)). When decoding can't keep up, frames are dropped, and the clock runs on.
- **Paused, nothing is drawn.** The canvas keeps the last frame.

### Cuts between clips

- **Clips decode in turn,** each through `decodeVideoFrames` over its source range.
- **Pre-roll:** when the clock is within one second of the current clip's end, the next clip's decoder starts, so its first frame is ready at the cut. At most two decoders run at once ([ADR 0004](0004-video-limits.md)).
- **Every frame is checked against the clip at the clock** before it's drawn: its source and its time must be the ones the plan places there. So no frame from another clip, an earlier seek or an earlier plan is drawn ([ADR 0005](0005-playback-and-export.md)).

### Seeking, scrubbing and edits

- **Seeking** aborts the running decoders, whose frames the decoder then closes ([ADR 0001](0001-video-engines.md)). It decodes from the key packet before the target, through `decodeVideoFrames`' range, and draws the latest frame at or before the target as soon as it's decoded. If playing, the clock's anchor moves to the target, and playback continues from there.
- **Seeks are coalesced.** A seek that arrives while another decodes replaces it: the earlier one is aborted, and only the latest target is drawn. Scrubbing is a stream of such seeks, and silent ([ADR 0005](0005-playback-and-export.md)).
- **An edit during playback** loads the new plan, then seeks to the current position under it. A playhead past the new plan's end moves to the end ([ADR 0003](0003-clip-plan-document-model.md)).
- **The end:** when the clock reaches the plan's end, playback stops with the playhead there, and the state becomes `stopped`.

### What crosses between the page and the worker

| From | To | What | When |
|---|---|---|---|
| Page | Worker | The transferred canvas | Once per mount |
| Page | Worker | The plan, and the sources' `Blob`s and probes | On load and on every edit |
| Page | Worker | Play, pause, seek, and clock anchors | On each, and every 250 ms while playing |
| Worker | Page | Dropped frames, and errors | With each anchor's reply |
| Worker | Page | Audio windows | Ahead of the clock (ADR 0005) |

No full-size frame ever crosses ([ADR 0002](0002-workers-and-assets.md)).

### Order of the work

1. **Video playback on the performance clock:** the scheduler, drawing, dropping, cuts, seeking and the output port.
2. **Audio:** windows on the `AudioContext`, the audio clock, autoplay, and the flash-and-beep sync test ([ADR 0005](0005-playback-and-export.md)).

### Tests

- **The scheduler's decisions are pure functions,** tested without a browser on a fake clock: which frame to draw, which to drop, when a cut pre-rolls, and how seeks coalesce.
- **In every engine,** a frame-numbered fixture plays, seeks and is edited during playback, and the worker reads back what it drew. It must be the frame the plan places at the clock, or a dropped frame counted.
- **The frame ledger is zero** after play, pause, seek, an edit during playback, stop and destroy ([ADR 0002](0002-workers-and-assets.md)).

## Alternatives considered

- **Posting each decoded frame to the page and drawing it there:** `VideoFrame`s can be transferred, but ownership would cross threads every frame, the page would draw on its main thread, and the close discipline would be split between two places.
- **A `<video>` element fed by Media Source Extensions:** the browser would keep audio and video in sync for us. But every plan and every edit would need remuxing into fragments, decoding would run on the page (sdk-core ADR 0031 rule 1), codec support through Media Source differs from WebCodecs', and frame-accurate seeking and cuts would depend on each browser's buffering.
- **`setTimeout` as the drawing clock:** it isn't aligned to the display, so frames would tear between refreshes and drift. `requestAnimationFrame` exists in every engine's workers.
- **The video as the master clock:** audio would have to stretch or skip to follow it, which people hear far more readily than a dropped frame ([ADR 0005](0005-playback-and-export.md)).
- **Refusing to play when autoplay blocks audio:** playback would fail in headless tests and before any gesture. Playing silently, and saying so, is more useful.

## Consequences

- **Memory stays at the decoder's queue bounds** during playback, at any length, because the wait for a frame's time is the back-pressure.
- **The page knows the playhead without per-frame messages,** from the same anchor the worker uses.
- **A frame-accurate preview depends on decoding keeping up.** Where it can't, as with 4K on a slow device, frames are dropped and counted, and the editor can suggest a smaller preview.
- **Audio playback depends on a user gesture,** as browsers require. Until then the output plays silently and reports `audio: "blocked"`.
