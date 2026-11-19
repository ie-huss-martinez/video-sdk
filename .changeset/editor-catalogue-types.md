---
"@hussmartinez/video-sdk": minor
---

**Breaking, for TypeScript only:** the types `VideoEditorCatalogue`, `VideoEditorMessages` and `VideoEditorMessageOverrides` are now exported from the main entry, `@hussmartinez/video-sdk`, and no longer from `@hussmartinez/video-sdk/react`. Nothing changes at run time. Change your imports:

```ts
// Before
import type { VideoEditorMessageOverrides } from "@hussmartinez/video-sdk/react";
// After
import type { VideoEditorMessageOverrides } from "@hussmartinez/video-sdk";
```

They moved because the React editor and the coming `<hm-video-editor>` element both use them, and the family keeps types shared by several entry points in the main one.
