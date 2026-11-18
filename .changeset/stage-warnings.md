---
"@hussmartinez/video-sdk": patch
---

The video editor now shows the session's warnings, which it computed but never showed. A video that is long or large, one whose sound this browser can't play, or a session using a lot of memory now gets a notice at the foot of the stage, above any error. Each notice is announced to screen readers once and can be dismissed with its Dismiss button, and a dismissed notice doesn't come back for the same video and limit. Two new messages name the area and the button: `stage.notices` and `stage.dismiss`. The text of each warning comes from `videoWarningText`, as before.
