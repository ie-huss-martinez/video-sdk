---
"@hussmartinez/video-sdk": patch
---

Playback no longer piles up frames in a browser that can't draw a `VideoFrame` directly and falls back to drawing through `ImageBitmap`s. If making bitmaps was slower than the video's frame rate, every frame still waiting to be drawn was kept open, so memory grew for as long as playback ran. Now at most one frame waits, and a newer one replaces it, as when frames arrive late. Nothing changes in your code.
