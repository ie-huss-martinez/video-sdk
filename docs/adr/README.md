# Architecture decision records

Decisions specific to `@hussmartinez/video-sdk`. Decisions for the whole SDK family live in [`sdk-core`'s `docs/adr`](https://github.com/ie-huss-martinez/sdk-core/tree/main/docs/adr); the records here build on them and never contradict them. To change a family decision, write a record in `sdk-core`.

Each record captures one significant decision: the context that forced it, what we chose, the alternatives we rejected and the consequences we accept. Records are numbered and immutable. To change a decision, write a new record that supersedes the old one and link the two.

Use [`template.md`](template.md) for new records. Name files `NNNN-short-title.md`, taking the next free number.

| # | Decision | Status |
|---|---|---|
| [0001](0001-video-engines.md) | Video engines: mediabunny to read and write containers, WebCodecs to decode and encode | Accepted |
| [0002](0002-workers-and-assets.md) | A media worker that owns decoding and the preview, an export worker, and assets without the network | Accepted |
| [0003](0003-clip-plan-document-model.md) | The clip plan: edits change a model in microseconds on a frame grid, and video is rendered on export | Accepted |
| [0004](0004-video-limits.md) | Video limits and session memory | Accepted |
| [0005](0005-playback-and-export.md) | Playback with audio as the clock, and export with progress, cancellation and nothing but the edit | Accepted |
| [0006](0006-frame-scheduler.md) | The frame scheduler: playback's clock, frame ownership, dropping and seeking | Accepted; refines [0002](0002-workers-and-assets.md) and [0005](0005-playback-and-export.md) |
| [0007](0007-editor-shell.md) | The editor shell: layout, the timeline, shortcuts and focus | Proposed |
