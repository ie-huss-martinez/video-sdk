---
"@hussmartinez/video-sdk": patch
---

Importing part of the core entry no longer brings the whole message catalogue into your bundle. A helper such as `frameTime` ships about 0.65 kB instead of 3.5 kB, and `createVideoSession` 7.7 kB instead of 10.6 kB, brotli-compressed with your bundler minifying. The catalogue, `videoMessages`, was built in a way some bundlers, such as esbuild, couldn't drop when unused. Nothing changes at run time.
