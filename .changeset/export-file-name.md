---
"@hussmartinez/video-sdk": patch
---

`VideoEditor` takes a `fileName`: the name an export downloads under, without its extension, such as the name of the file being edited. Before, the editor had no way to pass one to its export dialog, so every download was `video.mp4` or `video.webm`. Without a `fileName`, the video's title from the inspector is used, and then `video`. In every case the name is cleaned for file systems: characters they refuse, control characters and bidirectional overrides are removed, a video extension is dropped, as the export adds its own, and it's kept to 100 characters.
