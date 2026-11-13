---
"@hussmartinez/video-sdk": patch
---

A video frame or audio chunk that the browser's decoder delivers after the SDK has closed it, as Firefox can after an export or playback is cancelled, is now closed at once instead of being held until the worker ends.
