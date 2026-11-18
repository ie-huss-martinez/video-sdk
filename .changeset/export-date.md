---
"@hussmartinez/video-sdk": patch
---

An export writes the metadata date only as the real calendar date it names. Before, a date that doesn't exist, such as `2025-02-31`, was written as the day it rolls over to, 3 March, which nobody set. Now a date that isn't a real `YYYY-MM-DD` date isn't written at all, and the export dialog's summary says so before anything is written, rather than leaving it out silently.

Also note for this release, from 0.3.0's earlier changes: the snapshot's `warnings` are now a union, `VideoWarning`, of `{ type: "limit", … }` and `{ type: "audioUndecodable", … }`. TypeScript code that reads `warning.limit` must check `warning.type === "limit"` first; `videoWarningText(messages, warning)` handles both.
