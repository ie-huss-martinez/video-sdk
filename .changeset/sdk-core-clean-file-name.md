---
"@hussmartinez/video-sdk": patch
---

The name an export downloads under is now cleaned by `@hussmartinez/sdk-core`'s `cleanFileName`, which the family's editors share, instead of video-sdk's own copy of it. It also drops a lone surrogate, half of a character pair, as from a name cut mid-character, which no file system can store. Everything else about the name is as before. The package now needs `@hussmartinez/sdk-core` 0.4.7 or later; if your app depends on it too, update it to ^0.4.7, so there's one copy.

With sdk-core 0.4.6 and later, the editor's `messages.error(error)` also finds an error's text by its reason, such as "That output size has … pixels" for an output over `maxFramePixels`, as `videoErrorText` already did. Before, it gave the code's general text.
