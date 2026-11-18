---
"@hussmartinez/video-sdk": patch
---

After an edit or a seek during playback, the preview no longer draws a frame it already knows is late when a newer one has just been decoded. The first frame after the decoder restarts now follows the same rule as every other late frame: held until the next animation frame and replaced by a newer one decoded by then, and counted in `droppedFrames`. A paused seek still draws its frame as soon as it's decoded.
