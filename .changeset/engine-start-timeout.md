---
"@hussmartinez/video-sdk": patch
---

`createVideoEngine({ startTimeout })` sets how long the engine's workers, its outputs' and a processor's over it, may take to start before they fail with `WORKER_START_FAILED`. It defaults to sdk-core's 10 seconds, which the packaged worker stays well within even on a heavily loaded machine.
