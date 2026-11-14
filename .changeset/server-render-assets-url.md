---
"@hussmartinez/video-sdk": patch
---

`<VideoEditor assetsUrl="/video-sdk/">`, with self-hosted workers at a path relative to the page, renders on a server, as in Next.js. It threw there, because a server has no page to resolve the path against.
