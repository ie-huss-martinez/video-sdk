---
"@hussmartinez/video-sdk": patch
---

The React entry now comes apart in your bundle: importing one part no longer brings the whole editor. A hook such as `useVideoSession` ships about 0.7 kB instead of 18.5 kB, and `VideoExportDialog` 6.5 kB, brotli-compressed with your bundler minifying. Calls at the top level of the package's modules, such as the tool definitions, `forwardRef` and `createContext`, are now marked side-effect free, so bundlers can drop what you don't use. Nothing changes at run time.
