# video-sdk

A client-side video SDK: trim, split, arrange, rotate, crop and export videos entirely in the browser. Videos never leave the device. Its headless core and React editor (`VideoEditor`) are published; a `<hm-video-editor>` custom element comes later.

This repository publishes **[`@hussmartinez/video-sdk`](https://www.npmjs.com/package/@hussmartinez/video-sdk)**. It follows the family standards in [`sdk-core`'s `STANDARDS.md`](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md), and in particular the decisions on [hostile input and no network](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0012-hostile-input-and-no-network.md), [workers and assets](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0011-worker-messaging-and-assets.md) and [ports and adapters](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0008-ports-adapters-and-session.md).

> Status: pre-1.0. The headless core and the React editor are published. The editor's inspector sets a clip's volume, mute, fades, rotation, fit and crop, and, with no clip selected, the exported video's size, frame rate and sound, and its title and other details; the `<hm-video-editor>` element and audio tracks come later ([ADR 0008](docs/adr/0008-audio-editing.md) has the order). The API may change between minor versions until 1.0.

## Install

```sh
pnpm add @hussmartinez/video-sdk
```

React and React DOM 18.3 or later are optional peer dependencies, needed only for `@hussmartinez/video-sdk/react`. `@hussmartinez/ui` and `@hussmartinez/sdk-core` come with the package.

| Entry | What it has | Where it runs |
|---|---|---|
| `@hussmartinez/video-sdk` | The headless core: the session, commands, engine, playback output, export, limits, errors and messages | Anywhere, servers included: no React, and no DOM access on import |
| `@hussmartinez/video-sdk/react` | `VideoEditor`, its building blocks and hooks | Client components: it starts with `"use client"` |
| `@hussmartinez/video-sdk/element` | Nothing yet: the custom element comes in a later release | |
| `@hussmartinez/video-sdk/styles.css` | The editor's styles, in the `hm.sdk` cascade layer | Import it once, after `@hussmartinez/ui/styles.css` |

## The editor

```tsx
import "@hussmartinez/ui/styles.css";
import "@hussmartinez/video-sdk/styles.css";
import { VideoEditor } from "@hussmartinez/video-sdk/react";

export function Editor() {
  return (
    <VideoEditor
      filePolicy={{ maxDuration: 30 * 60 * 1_000 }} // or leave it out for the defaults
      locale="en"
      onEvent={(event) => analytics.track(event)} // anonymous: no names, frames, audio or metadata
    />
  );
}
```

It renders a toolbar, the preview with its transport, the timeline and the inspector: add videos, trim, split, move and delete clips, set their volume, mute and fades, rotate, fit and crop them, undo and redo, play, and export through a dialog that shows what the file will contain before the download. Every action has keys, listed in [ADR 0007](docs/adr/0007-editor-shell.md).

- **Props:** `initialFiles`, `fileName` (the name an export downloads under, such as the original file's, or the video's title otherwise, cleaned as the family cleans a file name, [pdf-sdk ADR 0009](https://github.com/ie-huss-martinez/pdf-sdk/blob/main/docs/adr/0009-saving-the-document.md)), `onExport` (takes the exported `Blob` instead of the download, such as to upload it), `filePolicy`, `assetsUrl`, `locale` and `messages`, `tools` and `toolbar` to choose the tools, `onEvent`, `engine` and `processor` to supply your own, and `className`.
- **The ref handle** has `insert(file, at?)`, `undo()`, `redo()`, `play()`, `pause()`, `seek(frame)` and `export(options?)`, which exports the plan as it is for a host's own export button, without the dialog, resolving with the file and what clamping did to its sound.
- **Building blocks:** `VideoEditorProvider` with `VideoToolbar`, `VideoStage`, `VideoTransport`, `VideoTimeline`, `VideoInspector` and `VideoExportDialog`, and the hooks `useVideoSession`, `useVideoOutput` and `useVideoPlayhead`, for a layout of your own.
- **Server rendering:** on a server the editor renders its empty state, with no canvas, engine or worker.
- **Layout follows the container,** not the viewport: an editor in a narrow column lays out for the column.

## The headless core

`createVideoSession()` holds what's being edited: a clip plan over immutable sources, edited with commands, with undo and redo ([ADR 0003](docs/adr/0003-clip-plan-document-model.md)). The engine reads files in a Web Worker, the output plays the plan into a canvas, and the processor exports it:

```ts
import {
  createVideoEngine,
  createVideoOutput,
  createVideoProcessor,
  createVideoSession,
  videoErrorText,
  videoMessages,
  videoWarningText,
} from "@hussmartinez/video-sdk";
import { createMessages } from "@hussmartinez/sdk-core";

const messages = createMessages(videoMessages, { locale: "en" });
const engine = createVideoEngine();
const session = createVideoSession({ engine, processor: createVideoProcessor({ engine }) });
const output = createVideoOutput({ engine, canvas });
session.subscribe(() => {
  const { plan } = session.getSnapshot(); // or useSyncExternalStore in React
  if (plan) output.load(plan);
});

try {
  await session.insert(file); // probed and checked against the limits before anything decodes

  // Split the first clip one second in, and make its first part quieter, fading in.
  const first = session.getSnapshot().plan?.clips[0];
  const { num, den } = session.getSnapshot().plan?.output.frameRate ?? { num: 30, den: 1 };
  if (first) {
    session.execute({
      type: "video.splitClip",
      key: first.key,
      at: Math.round(num / den), // a timeline position, in output frames
      newKey: session.newClipKey(),
    });
    session.execute([
      { type: "video.setVolume", keys: [first.key], volumeDb: -6 },
      { type: "video.setFade", key: first.key, edge: "in", duration: 500_000, curve: "equalPower" },
    ]); // one undo step; times are microseconds
  }
  session.undo(); // and session.redo()

  await output.play(); // call it from a click: browsers start audio only then

  // The plan as it is now; edits while it runs don't change the file.
  const { blob, peakDb, clippedFrames } = await session.export({ container: "mp4", signal });
  offerDownload(blob); // a Blob: the SDK never downloads anything itself
  if (clippedFrames > 0) warnTooLoud(peakDb); // the sound was clamped at full scale, by this much
  for (const warning of session.getSnapshot().warnings) show(videoWarningText(messages, warning));
} catch (error) {
  showError(videoErrorText(messages, error)); // text by code and reason, never the error's message
}
```

- **The snapshot** has the `plan` (the output's size and rates, the clips, and the metadata), the `sources`, `canUndo` and `canRedo`, how many files are being inserted, the last `error`, and `warnings`: limits past their warning thresholds, as `{ type: "limit", limit, actual, source? }`, whose text `videoWarningText` gives.
- **Commands** are plain data, such as `video.trimClip`, `video.moveClips`, `video.setMuted` or `video.setTransform`, with an exact inverse for undo. One that doesn't apply throws `INVALID_COMMAND` with a stable `details.reason`, such as `unknown-clip`.
- **Times** are whole microseconds, and positions on the timeline are output frames, so every edit lands on a whole frame ([ADR 0003](docs/adr/0003-clip-plan-document-model.md)).
- **Audio:** each clip has a volume, a mute and fades, and its sound stays with its picture through every edit. Playback uses the audio as its clock, so sound and picture stay within a frame of each other ([ADR 0005](docs/adr/0005-playback-and-export.md)).
- **Exports** decode, compose and encode every frame and sample again, faster than real time where the encoder is. The sound is clamped at full scale, never limited or normalised, and the result says how far over it was (`peakDb`) and for how many frames (`clippedFrames`). They contain only what the plan names and the metadata you set: nothing a user cut, and nothing from a source's own metadata, such as its location or device.
- **Plans are portable JSON:** `toVideoPlanDocument` and `readVideoPlanDocument` write and read the `hm-video-plan` format, whose JSON Schema ships in the package ([format record](docs/formats/hm-video-plan.md)).

### Formats

| | Containers | Codecs |
|---|---|---|
| Opening | MP4, MOV, WebM and Matroska, recognised by signature, never by name | Whatever the browser's WebCodecs decodes, such as H.264, VP8, VP9, AV1, AAC and Opus |
| Exporting | MP4, or WebM | H.264 with AAC, or with Opus where the browser has no AAC encoder; VP9 or VP8 with Opus in WebM |

Decoding and encoding are the browser's own, in workers, so support varies by browser: the SDK asks the one it runs in, and a file whose picture it can't decode fails with `UNSUPPORTED_CODEC`. A file whose sound it can't decode opens without sound, with a warning; and where it can't encode sound, an export fails with `UNSUPPORTED_CODEC` for the audio track, and `session.export({ audio: "omit" })` makes it without sound. [`docs/capabilities.md`](docs/capabilities.md) shows what Chromium, Firefox and WebKit offer in the test image. Encrypted files, files with several edits in an edit list and files without a video track are refused, with a reason ([ADR 0001](docs/adr/0001-video-engines.md)).

### Limits

Every file is treated as hostile. Before any decoder is configured, the SDK's own code checks the file's structure and walks every packet, and checks what it found, never what a header claims, against the file policy: size, frame size and rate, duration, bitrate, packet size, tracks, index size, channels and sample rate. Each has its own error code, and `filePolicy` raises or lowers any of them; a misspelt name throws. [ADR 0004](docs/adr/0004-video-limits.md) lists the defaults, such as 4 GB, 4K, 120 frames a second and 3 hours.

### Workers and Content Security Policy

| Mode | How | Directives |
|---|---|---|
| Inline (the default) | Nothing to set: the workers are inlined and start from `blob:` URLs | `worker-src blob:` |
| Self-hosted | `<VideoEditor assetsUrl="/video-sdk/" />`, or the same option for `createVideoEngine` and `createVideoProcessor`: serve the package's `dist/assets/` there; the workers are `video/media.worker.js` and `video/export.worker.js` | `worker-src 'self'` |

Neither mode needs `'unsafe-eval'`, `'wasm-unsafe-eval'` or `'unsafe-inline'` styles, and the SDK makes no network requests of its own: no CDN, fonts or telemetry ([ADR 0002](docs/adr/0002-workers-and-assets.md)). The [examples](examples) run under `default-src 'self'; script-src 'self'; style-src 'self'` with each `worker-src`, and the end-to-end suite fails on a policy violation or a request to another origin.

**Copy `dist/assets` again after every upgrade.** A self-hosted worker from another version of the SDK is refused with `WORKER_START_FAILED`, whose `details` name the file and both versions.

### Errors

Every failure is a `VideoError` with a stable `code` and structured `details`; `isVideoError(error, code)` checks one, across workers and copies of the package. Show people the text for the code from `videoMessages` through `createMessages`, never `error.message`.

| Code | When |
|---|---|
| `INVALID_VIDEO` | A file is malformed, its headers disagree with its packets, or it decodes to more than its probe allows |
| `UNSUPPORTED_FORMAT` | A container the SDK doesn't read, an encrypted file, an edit list it refuses, or no video track |
| `UNSUPPORTED_CODEC` | A video codec the browser can't decode, or nothing it can encode for an export; `details.track` says whether it's the picture or the sound |
| `DECODE_FAILED`, `ENCODE_FAILED` | The browser failed on a file or an export it claimed to support |
| `FILE_TOO_LARGE`, `FRAME_TOO_LARGE`, `DURATION_TOO_LONG` and the other limit codes | A file, the plan or an export exceeds a limit; `details` name it, with its maximum and the actual value |
| `INVALID_COMMAND`, `INVALID_DOCUMENT` | A command or a stored plan that doesn't apply, with a `details.reason` |
| `BUSY` | An export was requested while another runs |
| `PROCESSING_TIME_EXCEEDED`, `ABORTED` | A call ran out of `maxProcessingTime`, or its `signal` aborted |
| `UNSUPPORTED_ENVIRONMENT` | The browser lacks a feature, such as WebCodecs in workers, which `details.feature` names |
| `WORKER_START_FAILED`, `WORKER_CRASHED` and other `WORKER_*` codes | A worker couldn't start, stopped unexpectedly, or is from another version |

## Development

The repository root is the published package, laid out as in the family's [standard layout](https://github.com/ie-huss-martinez/sdk-core/blob/main/STANDARDS.md#repository-layout): the source is in [`src`](src). The pnpm workspace also holds the test applications ([ADR 0039](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0039-test-applications-in-each-repository.md)): [`examples/vite`](examples/vite) and [`examples/next`](examples/next), which run the built editor with its workers inlined and self-hosted, each under its Content Security Policy, and the [`e2e`](e2e) Playwright suite that tests them.

You need Node 24 (see [`.node-version`](.node-version)) and pnpm. The exact pnpm version is pinned in `package.json`, and pnpm switches to it automatically.

```sh
pnpm install       # also installs the git hooks
pnpm verify        # everything CI runs
pnpm verify:fast   # the subset the pre-push hook runs
```

Browser tests, the end-to-end tests and the screenshots run in the pinned browser image of `ci/Dockerfile`, as CI's do, through `hm-in-image` from [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config) ([sdk-core ADR 0049](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0049-local-browser-tests-in-the-pinned-image.md)). So they need Docker, and no browsers installed on the machine: the host's own libraries and network changes can't affect them. Pass a test file to run only it, such as `pnpm test:browser test/playback.browser.test.ts`, and use `pnpm test:browser:all` for all three engines. The [capability matrix](docs/capabilities.md) is checked there too.

`pnpm verify` runs, in order:

| Step | Script | Tool |
|---|---|---|
| Format and lint | `lint` | Biome |
| CSS rules | `lint:css` | stylelint, with the `hm-` namespace and token rules |
| Types | `typecheck` | TypeScript |
| Dependency rules | `lint:deps` | dependency-cruiser, through `hm-lint-deps` |
| Build | `build` | Vite, then api-extractor for the type declarations |
| Unit tests | `test` | Vitest |
| Browser tests | `test:browser` | Vitest in the browser image, in Chromium, and in Firefox and WebKit too in CI |
| Example builds | `build:examples` | Vite and Next.js, on the workspace's build of the package |
| End-to-end tests | `test:e2e` | Playwright in the browser image, against the built examples, in Chromium, and all three engines in CI |
| Screenshots | `test:visual` | Playwright, in the pinned browser image through Docker; `test:visual:update` rewrites the baselines ([sdk-core ADR 0048](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0048-visual-regression-for-sdk-editors.md)) |
| Size budgets | `check:size` | size-limit, brotli size of each entry point |
| API reports | `check:api` | api-extractor, one report per entry point in [`api`](api) |
| Package checks | `check:package` | publint and Are the Types Wrong? |

The configuration extends the shared presets in [`@hussmartinez/sdk-config`](https://www.npmjs.com/package/@hussmartinez/sdk-config). The git hooks ([ADR 0016](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0016-git-hooks-and-merge-guards.md)) run automatically: a secret scan and lint of staged files on commit, a Conventional Commits check of the message, and `pnpm verify:fast` on push.

When a change alters the public API on purpose, update the reports with `pnpm api:update` and commit them.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request. Coding agents also start with [`AGENTS.md`](AGENTS.md). Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately, as described in the [security policy](SECURITY.md).

## License

[Apache-2.0](LICENSE)
