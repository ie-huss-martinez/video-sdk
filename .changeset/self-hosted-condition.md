---
"@hussmartinez/video-sdk": patch
---

Apps that self-host the workers can now leave the inlined copies out of their build, about 605 kB minified, with the `hm-self-hosted` resolve condition (sdk-core ADR 0060). It's opt-in: without it, nothing changes.

```ts
// vite.config.ts
import { defaultClientConditions } from "vite";
export default { resolve: { conditions: ["hm-self-hosted", ...defaultClientConditions] } };
```

With the condition, the package's `#hm-video-media-worker` and `#hm-video-export-worker` imports resolve to a small stub instead of the inlined workers, so pass `assetsUrl` to `VideoEditor`, `createVideoEngine` and `createVideoProcessor`. Without `assetsUrl`, starting a worker fails with `WORKER_START_FAILED` and `details: { condition: "hm-self-hosted", missing: "assetsUrl" }`. esbuild's `conditions` works too; the README lists the other bundlers.
