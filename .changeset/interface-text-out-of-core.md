---
"@hussmartinez/video-sdk": minor
---

The editor's interface text has left the server-safe entry, so a server or a headless app no longer ships it (sdk-core ADR 0059). Importing `videoMessages` now costs 1.6 kB instead of 3.5 kB, and the core entry is 2 kB smaller.

- **`videoMessages`** (from `.`) now holds only what the headless API hands you to show: sdk-core's text, and errors' and warnings' text.
- **`videoEditorMessages`** is new, from `@hussmartinez/video-sdk/react`: the editor's whole catalogue, with `videoMessages`, `ui`'s text and the interface text. The editor, its components and `<hm-video-editor>` use it, so what they show doesn't change.
- **`VideoEditorMessageCatalogue`** is new, from `.`: its type, for typing overrides with `MessageOverrides<VideoEditorMessageCatalogue>`. `VideoEditorCatalogue`, `VideoEditorMessages` and `VideoEditorMessageOverrides` still work, deprecated, until the next breaking minor.

**Migrating:** if you read interface text such as `transport.play` from `videoMessages`, or typed overrides of it with `VideoMessageCatalogue`, use `videoEditorMessages` and `VideoEditorMessageCatalogue` instead. Keys and their text are unchanged, and the editor's `messages` prop takes the same overrides as before. Server code, such as a React Server Component, can't read `videoEditorMessages`, because `./react` is a client entry: show the editor's text from client components, where the editor runs, or keep your own text for what a server renders. `videoMessages` stays server-safe for errors and warnings.
