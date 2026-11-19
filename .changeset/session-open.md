---
"@hussmartinez/video-sdk": minor
---

`session.open(file)` and the editor handle's `open(file)` open a file in place of everything open: a new plan of all of it as one clip, whose output the file sets. The files open before are closed, and the history is cleared, so it can't be undone, as audio-sdk's `open` behaves. If the file fails, such as for a limit, the plan that was open stays, with its undo history. A newer `open` supersedes one still in progress. An `insert` still in progress when an `open` commits is rejected with `ABORTED` and `details.reason: "replaced"`, while one in flight during an open that fails or is cancelled still lands. Usage events gain the type `open`.
