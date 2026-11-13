---
"@hussmartinez/video-sdk": patch
---

Destroying a video output while its audio is still starting, as when the editor unmounts right after play is pressed, no longer rejects `play()` with a `TypeError`. The audio player's start is cancelled with `ABORTED`, and the output treats that as a cancelled play.
