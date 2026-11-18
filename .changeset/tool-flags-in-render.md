---
"@hussmartinez/video-sdk": patch
---

The toolbar's buttons now update in the same render as the editor. Before, a button's enabled state followed one render later: right after Zoom in widened the timeline, Zoom out still read as disabled for a moment, and a click on it then did nothing. The same applied to undo, redo, split, delete and the other tools.
