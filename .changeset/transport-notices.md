---
"@hussmartinez/video-sdk": patch
---

The transport's sound notices, "Sound is off: press play to turn it on." and "The sound couldn't be decoded, so the video plays without it.", are now announced to screen readers when they appear, through the editor's announcer, as the stage's notices are. Before, each was a live region that appeared together with its text, which many screen readers don't announce. They look the same.
