---
"@hussmartinez/video-sdk": minor
---

`VideoEditor`'s ref handle has `export(options?)`, as the family's editors' handles do, for a host's own export button. It exports the plan as it is when it's called, through the editor's processor or the host's `processor`, without opening the dialog, and resolves with `{ blob, container, size, peakDb, clippedFrames }`. It takes `session.export`'s options: `container`, `quality`, `audio: "omit"`, `signal`, `onProgress` and `onWarning`. It never downloads anything, and doesn't call `onExport`, since the caller has the file.
