---
"@hussmartinez/video-sdk": minor
---

First release of `@hussmartinez/video-sdk`, a video SDK that works entirely in the browser: videos are opened, edited and exported on the user's device and never uploaded.

- **Package shape:** an ES module package with a server-safe headless core (`@hussmartinez/video-sdk`), a React entry (`@hussmartinez/video-sdk/react`), a custom element entry (`@hussmartinez/video-sdk/element`) and one stylesheet (`@hussmartinez/video-sdk/styles.css`), which applications import once. React and React DOM 18.3 or later are optional peer dependencies.
- **Errors:** every failure is a `VideoError` with a stable `code`, such as `INVALID_VIDEO`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_CODEC` or `FRAME_TOO_LARGE`, and structured `details`. `isVideoError(error, code)` checks one, across workers and copies of the package.
- **Limits for untrusted files:** `videoLimits` adds `maxFramePixels`, `maxFrameRate`, `maxDuration`, `maxBitrate`, `maxPacketSize`, `maxTracks`, `maxIndexSize`, `maxChannels`, `maxSampleRate`, `maxSessionSize` and `maxClips` to the family's limits on file size, file count, decoded size and processing time, with defaults sized for video: 4K frames, 3 hours and 4 GB files. `maxDuration`, `maxChannels`, `maxSampleRate`, `maxSessionSize` and `maxClips` have the same names and codes as in `@hussmartinez/audio-sdk`. Set them with a `filePolicy`; a misspelt limit name throws instead of being ignored.
- **Translatable text:** `videoMessages` is the English catalogue for every error code and limit warning, for `createMessages` from `@hussmartinez/sdk-core`. Error text comes from the code and its details, never from the error's message.
