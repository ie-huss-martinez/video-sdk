---
"@hussmartinez/video-sdk": minor
---

Refusals that aren't about a file now say what was refused. Setting an output over a limit, such as a size over `maxFramePixels`, used to show the text for a video that's too large to open; an edit that would make the video longer than `maxDuration` said the video was too long to open. Now:

- `checkOutput` throws with `details.reason: "output"`, and `checkPlanLength` with `details.reason: "plan-too-long"`, on the same codes as before.
- The catalogue has their text under `errors.<CODE>.<reason>`: `errors.FRAME_TOO_LARGE.output`, `errors.FRAME_RATE_TOO_HIGH.output`, `errors.TOO_MANY_CHANNELS.output`, `errors.SAMPLE_RATE_TOO_HIGH.output` and `errors.DURATION_TOO_LONG.plan-too-long`. Override them like any other message.
- New `videoErrorText(messages, error)` returns that text when the error has a reason the catalogue knows, and `messages.error(error)` otherwise. The editor's stage and export dialog use it. If you show the session's errors yourself, call it in place of `messages.error(error)`:

```ts
showError(videoErrorText(messages, error));
```

A file's own refusals carry no reason, and their text is unchanged.
