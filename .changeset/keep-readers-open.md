---
"@hussmartinez/video-sdk": patch
---

Changing a clip's sound while the video plays no longer pauses playback. In 0.2.0, a mute, a volume change, a fade, or a drag of the inspector's volume slider while playing could stop playback after a moment, in every browser, because the preview's worker closed the file the picture was being decoded from. Playback now goes on, and the change is heard.
