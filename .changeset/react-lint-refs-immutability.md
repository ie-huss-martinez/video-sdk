---
"@hussmartinez/video-sdk": patch
---

The editor no longer writes refs while rendering, which React's concurrent rendering doesn't allow for. `VideoEditorProvider` keeps the host's latest `onEvent`, and its export processor, with `useLatest` from `@hussmartinez/ui`, which updates them as React commits. `VideoToolbar` registers its file picker with the editor through a function. Nothing changes for users.
