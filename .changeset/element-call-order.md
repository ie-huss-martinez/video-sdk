---
"@hussmartinez/video-sdk": patch
---

`<hm-video-editor>`'s methods now run in the order you call them. Once the editor is ready, `open`, `insert`, `export` and `play` call it at once instead of a microtask later, so `editor.play(); editor.pause();` in one task ends paused, and an `open` or `insert` followed by `undo` acts in that order. Before the editor is ready they still wait for it, and reject with `ABORTED` if the element is removed first.
