---
"@hussmartinez/video-sdk": minor
---

A new usage event tells you when the export dialog's Download hands the file to the browser. `export` comes when the file is ready, before anyone clicks Download, so a leave-page warning can't clear on it. The browser can still cancel or fail the save, so `download` marks the hand-off, not a confirmed save. The editor now sends `{ type: "download", outcome: "done", commands: [] }` to `onEvent`, and to `<hm-video-editor>`'s `hm-video-editor-event`, when Download hands the file to the browser. `VideoSessionEvent["type"]` gains `"download"`; if you switch on it, handle the new value. Like every usage event, it carries no file name or size. When you pass `onExport`, you save the file, so no `download` comes.
