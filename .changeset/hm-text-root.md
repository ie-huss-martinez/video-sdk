---
"@hussmartinez/video-sdk": patch
---

The editor's root now has ui's `hm-text` class, which sets its own text's font, size, weight, letter spacing, line height and colour from the theme's tokens. It replaces the SDK's own rules on `.hm-video-editor`, so the editor's text follows ui's type tokens with the other SDKs'. The stylesheet from `@hussmartinez/ui` 0.11 or later must be loaded, as before. Host CSS that styles `.hm-video-editor` still wins.
