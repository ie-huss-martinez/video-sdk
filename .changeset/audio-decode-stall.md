---
"@hussmartinez/video-sdk": minor
---

A stalled audio decoder no longer freezes playback. Before, pressing play could leave the preview on its first frame, "playing" with no error, when the browser's audio decoder held packets or missed a `dequeue` event, as WebKit's sometimes did.

- **Decoding:** the audio decoder now has the same stall guard as the video decoder. A stall gives it more packets, and one that stops for good fails with `DECODE_FAILED` and `details: { reason: "stalled", track: "audio" }`.
- **Playback goes on with the picture only** when the sound doesn't decode. `VideoOutputSnapshot.audio` has a new value, `"undecodable"`, and the editor's transport shows "The sound couldn't be decoded, so the video plays without it." The next `play()` tries the sound again. If you switch on `audio`, handle the new value.
- **Export fails instead:** an export whose sources' audio stalls rejects with that `DECODE_FAILED` error; it never writes a file without its sound. A stall while the export checks that the browser can encode AAC isn't bounded by this guard: the export's `maxProcessingTime` stops it, with `PROCESSING_TIME_EXCEEDED`.
