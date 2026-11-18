---
"@hussmartinez/video-sdk": patch
---

The video editor now says when playback fails. Before, when the browser couldn't decode or draw the video, playback paused silently: the stage stayed as it was and Play did nothing, with no message. Now the failure's text shows at the foot of the stage as an alert, looked up by its code like the editor's other errors, such as "This browser couldn't play part of this video." Pressing Play again clears it and tries again.
