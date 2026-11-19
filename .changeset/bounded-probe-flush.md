---
"@hussmartinez/video-sdk": patch
---

An export no longer waits on an encoder or decoder that stopped while the export checks what this browser can encode. The check's flushes now give up after 2 seconds without output, and the check then proves nothing: the export tries the next format, or fails with `UNSUPPORTED_CODEC` and `details.track` set to `"audio"` or `"video"`, so you can offer an export without sound. Before, such an export waited for its `maxProcessingTime` and failed with `PROCESSING_TIME_EXCEEDED`.

Fixed in 0.7.0, though its changelog didn't mention it: decoding no longer deadlocks when the browser's decoder hands back several frames or chunks of sound while the next packet is read. Both the video and audio decoders now take that output before waiting for room. Before, playback, thumbnails or an export could wait forever.
