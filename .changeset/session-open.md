---
"@hussmartinez/video-sdk": minor
---

`session.open(file)` and the editor handle's `open(file)` open a file in place of everything open: a new plan of all of it as one clip, whose output the file sets. The files open before are closed, and the history is cleared, so it can't be undone, as audio-sdk's `open` behaves. If the file fails, such as for a limit, the plan that was open stays, with its undo history. A newer `open` replaces one still in progress, and an `insert` still in progress when an `open` lands is rejected with `ABORTED` and `details.reason: "replaced"`. Usage events gain the type `open`.
