---
"@hussmartinez/video-sdk": patch
---

`@hussmartinez/video-sdk/react` exports three types its API already used without naming them: `VideoEditorCatalogue`, the shape of the catalogue behind `VideoEditorMessages` and `VideoEditorMessageOverrides`, and `UseVideoSessionResult` and `UseVideoOutputResult`, what the `useVideoSession` and `useVideoOutput` hooks return. Nothing changes at run time. The core's types that the React entry mentions, such as `VideoSession` and `VideoOutput`, are imported from `@hussmartinez/video-sdk`, as before.
