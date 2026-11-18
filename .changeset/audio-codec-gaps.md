---
"@hussmartinez/video-sdk": minor
---

A browser that can't decode or encode a video's sound no longer stops you editing it.

- **A file whose sound this browser can't decode opens with its picture,** instead of failing with `UNSUPPORTED_CODEC`. Its `VideoSourceInfo` has `audio: null` and `unplayableAudio: { codec }`, and the session's warnings include `{ type: "audioUndecodable", source, codec }`, whose text says the video opened without sound. A browser without `AudioDecoder` in workers behaves the same way. A video codec it can't decode still fails, now with `details.track: "video"`.
- **An export needs an audio encoder only when the plan has sound.** Where the browser can't encode the sound, the export fails with `UNSUPPORTED_CODEC` and `details.track: "audio"`, instead of `UNSUPPORTED_ENVIRONMENT` or a failure naming the video. `VideoExportJob.audio` and `session.export`'s `audio` take `"omit"` to export without sound; sound is never left out otherwise. The export dialog says the browser can't save the sound and offers "Export without sound", with "No sound" in its summary.
