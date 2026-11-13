---
"@hussmartinez/video-sdk": minor
---

The clip plan and its edit commands have portable, versioned JSON formats, `hm-video-plan` and `hm-video-command` version 1, with JSON Schemas in the repository's `formats/` and conformance vectors in `conformance/` (docs/formats/hm-video-plan.md).

- `readVideoPlanDocument(json)` reads a plan document and `toVideoPlanDocument(plan, sources)` writes one. `videoPlanDocumentSource(info)` gives what a document records of an open source. A document of another format or a later version is refused with `UNSUPPORTED_FORMAT`, and any other invalid document with the new code `INVALID_DOCUMENT`.
- Every refusal of a command carries a stable `details.reason`, such as `off-grid`, `unknown-clip` or `key-taken`, listed as `VideoCommandRejection`. Hosts can compare it instead of the message.
- The reducer reads commands strictly: a command with a field it doesn't have is refused as `malformed-command`, rather than the field being ignored. `createVideoReducer` needs only each source's duration and picture size and rotation, as `VideoSourceBounds`.
- Undo of `video.setOutput` is its own command, `video.restoreOutput`, so `video.setOutput` no longer takes `clips`.
