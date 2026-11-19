---
"@hussmartinez/video-sdk": patch
---

A video decoder that stops altogether no longer leaves playback, thumbnails or an export waiting forever at the end of a stretch of video. Its final flush now gives up after 2 seconds with no frame, with `DECODE_FAILED` and `details.reason: "stalled"`, and the decoder is closed. Frames are now handed on as the flush produces them. A slow consumer, such as playback holding a frame until its time, isn't mistaken for a stall.
