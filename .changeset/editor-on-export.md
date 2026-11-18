---
"@hussmartinez/video-sdk": minor
---

`VideoEditor` takes `onExport(blob, result)`, as the family's editors do: it receives each export's file instead of the download, with `result.container` (`mp4` or `webm`) and `result.size`, so a host can upload it or save it its own way. The export dialog closes once it's called. `VideoExportDialog` already had it; the editor didn't pass it on.
