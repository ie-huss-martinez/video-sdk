---
"@hussmartinez/video-sdk": patch
---

The JSON Schemas of `hm-video-plan` and `hm-video-command` now ship with the package, as `@hussmartinez/video-sdk/formats/hm-video-plan/v1.schema.json` and `@hussmartinez/video-sdk/formats/hm-video-command/v1.schema.json`, so a host can validate documents against the schemas that match its installed reader (sdk-core ADR 0045, section 8).
