---
"@hussmartinez/video-sdk": patch
---

Some editor state now resets while the editor renders, instead of in an effect after the screen has updated:

- `VideoInspector` drops a volume gesture's value in the same update as an undo or another change to the volume, so the old value no longer shows for a frame.
- `VideoExportDialog` resets its choices when it opens instead of when it closes. It still always opens fresh, and while it closes it keeps showing what it showed.
- `VideoStage` tells from the engine and the browser whether the preview is available, before it creates a canvas.
