---
"@hussmartinez/video-sdk": minor
---

With no clip selected, the inspector shows the whole video's settings. "The exported video" sets the width and height in pixels, the frames per second (29.97 becomes the exact 30000/1001), the sound quality (44.1 or 48 kHz) and mono or stereo; a size or rate over your `filePolicy`'s limit is refused in the field, with the limit. "Details in the file" sets the title, artist, date, description and comment, the only metadata an export writes; a value is set on Enter or when focus leaves, and the date must be a real date as year-month-day. Each change is one undo step.

The catalogue gains the messages for it, under `inspector.*`, and `inspector.empty` now also says that these settings are for the whole video.
