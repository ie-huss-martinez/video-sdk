---
"@hussmartinez/video-sdk": patch
---

The video editor now shows the session's warnings, which it computed but never showed. A video that is long or large, one whose sound this browser can't play, or a session using a lot of memory now gets a notice at the foot of the stage, above any error. There's one notice per kind of warning, so a long file and the long video it makes say it once. Each notice is announced to screen readers once and can be dismissed with its Dismiss button, and a dismissed kind doesn't come back, even after an undo and a redo. Two new messages name the area and the button: `stage.notices` and `stage.dismiss`. The text of each warning comes from `videoWarningText`, as before.
