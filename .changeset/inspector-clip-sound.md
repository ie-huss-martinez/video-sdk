---
"@hussmartinez/video-sdk": minor
---

The editor has an inspector for the selected clips' sound: a volume slider with a number field in decibels, mute, and a fade in and fade out, each with its length in seconds and its shape. A change applies to every selected clip as one undo step, and a drag of the volume slider is one step too.

`VideoEditor` shows it under the timeline in a narrow container and beside the other regions from 720 px. `VideoInspector` is exported from `@hussmartinez/video-sdk/react` as a building block, for a layout of your own inside a `VideoEditorProvider`. The catalogue gains the `inspector.*` messages.

The editor's root is now a two-column grid. Host CSS that sets `grid-template-columns` or `gap` on `.hm-video-editor` should be checked against it.
