---
"@hussmartinez/video-sdk": patch
---

`VideoEditor` takes a `fileName`: the name an export downloads under, such as the name of the file being edited. Before, the editor had no way to pass one to its export dialog, so every download was `video.mp4` or `video.webm`. Without a `fileName`, the video's title from the inspector is used, and then `video`.

The name is cleaned as the family cleans a file name, by the same rules as `@hussmartinez/pdf-sdk` and `@hussmartinez/audio-sdk` ([pdf-sdk ADR 0009](https://github.com/ie-huss-martinez/pdf-sdk/blob/main/docs/adr/0009-saving-the-document.md)): only the last path segment is kept, so `Holiday/day 1.mov` gives `day 1`; control characters, bidirectional formatting characters and the characters Windows refuses are removed; leading dots are trimmed; and it's at most 128 characters. Then a video extension is dropped, as the export adds its own.
