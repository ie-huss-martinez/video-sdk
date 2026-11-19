---
"@hussmartinez/video-sdk": minor
---

The `<hm-video-editor>` custom element, for pages without React of their own. Import `defineVideoEditorElement` from `@hussmartinez/video-sdk/element` and call it once; importing registers nothing. It renders `VideoEditor` into its light DOM, so React and React DOM are still needed.

- **Attributes:** `theme`, `locale` and `tools`.
- **Properties:** `file`, which opens a video in place of the plan when set (a failed open keeps the plan), plus `fileName`, `filePolicy`, `assetsUrl`, `messages`, `engine` and `processor`.
- **Methods:** `open`, `insert`, `export`, `undo`, `redo`, `play`, `pause` and `seek`.
- **Events:** `hm-video-editor-change` (the plan), `-event` (the usage event), `-export` (a `VideoExportReport`: container, size, peak and clamped frames, never the file) and `-error` (a failure's `code` and `details`). None carries a file name or contents.
