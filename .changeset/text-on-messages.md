---
"@hussmartinez/video-sdk": patch
---

`videoErrorText` and `videoWarningText` are deprecated. Call `messages.error(error)` and `messages.warning(warning)` on the catalogue's `Messages` instead: since `@hussmartinez/sdk-core` 0.4.6 they give the same text, an error's by its code and reason, and a warning's by its limit or type. Both functions keep working as one-line calls to them, so nothing you show changes.

```ts
const messages = createMessages(videoMessages, { locale: "en" });
showError(messages.error(error));           // was videoErrorText(messages, error)
show(messages.warning(snapshot.warnings[0])); // was videoWarningText(messages, warning)
```
