---
"@hussmartinez/video-sdk": patch
---

Stopping an export in its first moment now stops it. The first export of a session loads its worker code first, and an export stopped or closed during that load, which takes longer on a busy device, used to start anyway and run to its end unseen. Meanwhile the next export failed with "A video is already being saved", for as long as the hidden one ran. Now an export stopped while its code loads never starts, `processor.export()` rejects it with `ABORTED`, and the next one runs at once.
