---
"@hussmartinez/video-sdk": patch
---

The editor's timeline is now built on `ui`'s `Timeline`, as audio-sdk's is, so both editors' timelines look and behave the same. The keys, the clips' names, trimming, snapping and zoom are unchanged. Two things differ:

- **The playhead slider sits on the track,** as wide as it, instead of above it with a visible "Playhead" label. Screen readers still hear it as "Playhead", with the time.
- **The playhead goes to the end of the video,** one frame past the last, which is where playback stops.

Nothing changes in your code.
