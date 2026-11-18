---
"@hussmartinez/video-sdk": minor
---

**Breaking.** Exports say what they did to the sound, and the session can export.

- **`VideoProcessor.export` resolves with a result, not a `Blob`:** `{ blob, container, size, peakDb, clippedFrames }`. `peakDb` is the mix's peak before clamping, in decibels relative to full scale (above 0 means it was too loud, by that much; `-Infinity` for silence), and `clippedFrames` counts the sample frames that were over full scale. The same shape as `@hussmartinez/audio-sdk`'s. Migrate with `const { blob } = await processor.export(job)`.
- **The sound is clamped at full scale,** in playback and export alike, and a sample that isn't a number is silence. Before, a clip turned up past full scale was passed to the encoder over it. Nothing is limited or normalised: the export dialog says when the sound was clamped, and by how much.
- **`session.export(options)`** exports the plan as it is when the call starts, with `container`, `quality`, `signal`, `onProgress` and `onWarning`. `createVideoSession` takes a `processor` for it, such as `createVideoProcessor({ engine })`; without one, `export()` throws `TypeError`. An export emits an `export` event with its outcome.
- **The snapshot's `warnings` are objects,** `{ type: "limit", limit, actual, source? }`, not limit names: the value that came near the limit, and the source a file's own warning is about. `checkProbe` and `checkOutput` return them too, and `checkPlanLength` returns its warning or `undefined` instead of a boolean. Show their text with the new `videoWarningText(messages, warning)`. Migrate `warnings.includes("maxDuration")` to `warnings.some((w) => w.limit === "maxDuration")`.
- **`VideoExportResult` is now the core's,** exported from `@hussmartinez/video-sdk`, and is what `VideoEditor`'s and `VideoExportDialog`'s `onExport` receive as their second argument. `@hussmartinez/video-sdk/react` no longer exports its own `VideoExportResult`: import it from `@hussmartinez/video-sdk`.
