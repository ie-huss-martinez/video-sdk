# `hm-video-plan` and `hm-video-command`, version 1

video-sdk's portable formats ([sdk-core ADR 0045](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0045-portable-formats-and-conformance-vectors.md)). A port in another language reads and writes them, and proves it applies commands as this SDK does by passing the vectors in [`conformance/`](../../conformance).

| Format | Schema | What it holds |
|---|---|---|
| `hm-video-plan` 1 | [`formats/hm-video-plan/v1.schema.json`](../../formats/hm-video-plan/v1.schema.json) | A clip plan ([ADR 0003](../adr/0003-clip-plan-document-model.md)), with the sources its clips use |
| `hm-video-command` 1 | [`formats/hm-video-command/v1.schema.json`](../../formats/hm-video-command/v1.schema.json) | One user-level edit command |

## `hm-video-plan`

```json
{
  "format": "hm-video-plan",
  "version": 1,
  "output": {
    "width": 640,
    "height": 360,
    "frameRate": { "num": 30000, "den": 1001 },
    "sampleRate": 48000,
    "channels": 2
  },
  "sources": {
    "s1": { "duration": 10000000, "width": 1920, "height": 1080, "rotation": 0 }
  },
  "clips": [
    {
      "key": "a",
      "source": "s1",
      "start": 0,
      "end": 1001000,
      "volumeDb": -3.5,
      "muted": false,
      "fadeIn": { "duration": 200000, "curve": "equalPower" },
      "fadeOut": { "duration": 0, "curve": "linear" },
      "transform": { "rotation": 0, "crop": null, "fit": "contain" }
    }
  ],
  "metadata": { "title": "Take 1", "description": "", "artist": "", "date": "", "comment": "" }
}
```

- **Numbers:** every time is a whole number of microseconds, and the frame rate is an exact fraction (ADR 0045, section 3). A clip's `end` is a whole number of output frames after its `start`, by `start + round(frames × 1,000,000 × den / num)`, within one microsecond. `volumeDb` is the one float. It's copied, never computed, so it compares exactly.
- **Sources** are keyed by the ids the clips use, which only mean something within the document. Each gives what a clip is checked against: its length, and its picture's size before its own rotation, for crops. Once documents travel with their files, it also gives an `asset`: the SHA-256 of the bytes, their media type and their size. A document never inlines video.
- **Crops** are in pixels of the picture as it's shown: after the source's rotation and the clip's.
- **Lengths are counted in Unicode code points,** as JSON Schema's `maxLength` counts them, and as a port counts characters, such as Rust's `chars()`: never UTF-16 code units or bytes. An emoji such as 🎬 is one. Metadata values are at most 1,000 code points.
- **Beyond the schema,** a reader checks what depends on the whole document: every clip lies within a source the document lists, on the output's frame grid, its fades fit it together, its crop fits its source, and keys are unique.
- **Strict:** an unknown field anywhere is refused, never dropped. So a later version's document can't be misread as this one.
- **Hostile keys:** source ids and clip keys such as `__proto__`, `constructor` and `toString` are ordinary data. The vectors include each of them.

`readVideoPlanDocument(json)` reads a document, and `toVideoPlanDocument(plan, sources)` writes one. `videoPlanDocumentSource(info)` gives what a document records of a source the session opened.

## `hm-video-command`

The edits a user makes: `video.insertClips`, `video.removeClips`, `video.deleteRange`, `video.trimClip`, `video.splitClip`, `video.moveClips`, `video.setVolume`, `video.setMuted`, `video.setFade`, `video.setTransform`, `video.setOutput` and `video.setMetadata`, as [ADR 0003](../adr/0003-clip-plan-document-model.md) describes them. The commands undo runs, `video.restoreClips` and `video.restoreOutput`, are internal and aren't part of the format. The reducer refuses unknown fields here too, and checks a command's own values before the plan's clips, so a command the schema refuses is refused for that.

## Rejections

A refusal is compared by its code and `details.reason`, never its message:

| Code | Reasons |
|---|---|
| `UNSUPPORTED_FORMAT` | `unknown-format`, `unknown-format-version` |
| `INVALID_DOCUMENT` | `malformed-document`, `duplicate-key`, `metadata-too-long`, an output's problems (`invalid-output-size`, `invalid-frame-rate`, `invalid-sample-rate`, `invalid-channels`) and a clip's (`missing-key`, `invalid-range`, `volume-out-of-range`, `invalid-muted`, `invalid-fade`, `invalid-fade-curve`, `invalid-rotation`, `invalid-fit`, `invalid-crop`, `crop-too-small`, `unknown-source`, `off-grid`, `clip-outside-source`, `fades-too-long`, `crop-outside-source`) |
| `INVALID_COMMAND` | `VideoCommandRejection`'s tokens: `malformed-command`, `unknown-command`, `no-clips`, `duplicate-key`, `key-taken`, `unknown-clip`, `not-a-boundary`, `empty-range`, `frame-outside-plan`, `not-inside-clip`, `new-key-required`, `unexpected-key`, `invalid-edge`, `unknown-metadata-field`, `metadata-too-long`, and the output's and a clip's problems above. Undo's `invalid-index` and `invalid-order`, the session's `no-plan` and the processor's `empty-plan` aren't reachable from the format |

## The vectors

| File | Subject | A case's input | Its expected result |
|---|---|---|---|
| [`conformance/hm-video-plan.json`](../../conformance/hm-video-plan.json) | `hm-video-plan` | A document | The document as a reader writes it back, or the rejection |
| [`conformance/hm-video-commands.json`](../../conformance/hm-video-commands.json) | `hm-video-commands` | `{ plan, command }` | The resulting document, or the rejection. The command's inverse must also restore the plan |

Hand-written cases cover every outcome. Generated ones come from the reducer's property-test generators, with a fixed seed: 60 commands that apply, and 20 documents. `pnpm conformance:update` rewrites the files, and the tests fail when the checked-in files differ from what the generator writes.

The TypeScript tests also check that the schemas agree with the readers. Every document and command the vectors accept passes its schema, and every structural refusal fails it. Over thousands of mutated inputs, the reducer and the reader never accept anything their schema refuses.

## Changing the formats

A breaking change is a new version, with its schema beside this one and a migration from version 1 (ADR 0045, section 1). A reader refuses a later version with `UNSUPPORTED_FORMAT` and `unknown-format-version`.
