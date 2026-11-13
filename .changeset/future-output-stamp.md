---
"@hussmartinez/video-sdk": patch
---

Playback no longer drops a few frames about a quarter of a second in on WebKit on Linux. Its audio output timestamps run on another timeline, and while the audio context was young they passed the check for believable timestamps, so the clock started up to 200 ms late and then jumped forward.
