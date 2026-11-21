---
"@hussmartinez/video-sdk": patch
---

Some editor state now resets while the editor renders, instead of in an effect after the screen has updated:

- `VideoInspector` drops a volume gesture's value in the same update as an undo or another change to the volume, so the old value no longer shows for a frame.
- `VideoExportDialog` resets as it opens and closes. Closing drops a finished export's file, so a closed dialog keeps no video in memory. Opening starts fresh.
- `VideoStage` tells from the engine and the browser whether the preview is available, before it creates a canvas. If creating the preview still fails, it shows the same notice as before.
