---
"@hussmartinez/video-sdk": patch
---

When the sound stalls during playback, the picture now waits for it within about one frame, instead of running up to a quarter of a second ahead. The preview reads the audio clock more often, and corrects the picture as soon as the clock has moved by more than a frame. The correction no longer restarts decoding from a key frame, so the picture doesn't fall further behind while it catches up.
