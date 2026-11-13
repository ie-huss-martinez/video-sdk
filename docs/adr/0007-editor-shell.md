# 0007. The editor shell: layout, the timeline, shortcuts and focus

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

The headless core is built: the session ([ADR 0003](0003-clip-plan-document-model.md)), playback with audio as the clock ([ADR 0006](0006-frame-scheduler.md)), and export ([ADR 0005](0005-playback-and-export.md)). The React entry and the custom element come next. The family fixes most of their shape:

- **Four layers:** the full editor, building blocks, hooks, and the headless core (STANDARDS, "React API"). Every editor takes the same configuration props, and a ref handle for programmatic control.
- **`ui` provides the controls:** Toolbar, Button, ToggleButton, Slider, NumberField, Field, SegmentedControl, Dialog, FileDropZone, Progress, Announcer and the icon set ([ADR 0036](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0036-ui-as-a-dependency-of-the-sdks.md)), each to its component contract ([ui ADR 0003](https://github.com/ie-huss-martinez/ui/blob/main/docs/adr/0003-component-contract.md)). It has no timeline.
- **Tools and shortcuts** go through `sdk-core`'s `defineTool`, `createToolRegistry` and `createShortcutRegistry`, with the family's shortcuts, scoped to the editor's root ([ADR 0009](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0009-features-as-tools.md), [ADR 0030](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0030-tools-and-keyboard-shortcuts.md)).
- **The element** is `sdk-core`'s `createEditorElement`, rendering the React editor into the light DOM ([ADR 0040](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0040-editor-element-base.md)).
- **WCAG 2.2 AA:** full keyboard support with an alternative to every drag, visible focus, native dialogs, `aria-live` results, and targets of at least 24 px (44 px on touch). No inline text.

What the family leaves to this SDK: the layout of a video editor, the timeline, its keyboard model, where focus goes after each action, and how a canvas that's transferred to a worker survives React.

## Decision

### Layout

`<VideoEditor>` renders one root, `.hm-video-editor`, with these regions in order, which is also the tab order:

1. **Toolbar** (`ui` Toolbar): insert, undo and redo, split, delete, and export, built from the tool registry.
2. **Stage:** the preview canvas, letterboxed in the space left, with the transport under it: play and pause, previous and next frame, and the time as `0:12.40 / 1:05.00`.
3. **Timeline:** the clips on one track, with a waveform lane from the sources' peaks, and the playhead.
4. **Inspector:** the selected clip's volume, mute, fades, rotation, crop and fit, from `ui`'s fields. With no clip selected, the output's size and frame rate, and the metadata.

Below a container width of 720 px the inspector moves under the timeline. Sizes come from a container query on the root, not the viewport, so an editor in a narrow column lays out for the column.

**Designed states** (STANDARDS, "UX"):

- **Empty:** `ui`'s FileDropZone fills the stage, with a button to choose files, so dropping is never the only way.
- **Inserting:** a Progress per file in the timeline's place for it, which can be cancelled.
- **Error:** the catalogue's text for the code, where the action was, with the next step. An insert that fails leaves nothing behind ([ADR 0003](0003-clip-plan-document-model.md)).
- **Audio blocked:** when the output's `audio` is `"blocked"` ([ADR 0006](0006-frame-scheduler.md)), a notice by the transport says sound needs a click on play.

### The stage's canvas

- **The canvas is `role="img"`,** named from the catalogue as "Video preview, frame {frame} of {frames}", updated when paused and not every frame while playing. The time display next to it is the live text.
- **It's created imperatively, never rendered by React.** A transferred canvas can't be transferred again, and React's StrictMode mounts effects twice in development. So an effect creates the `<canvas>`, appends it to the stage, and creates the output with it; its cleanup destroys the output and removes the canvas. A second mount gets a fresh canvas and output.
- **Its size follows the stage:** a ResizeObserver calls `resize(width, height, devicePixelRatio)` ([ADR 0006](0006-frame-scheduler.md)), and so does a change of `devicePixelRatio`, through `matchMedia`.

### The timeline

**`<VideoTimeline>` is a building block in this SDK, not a `ui` component, for now.** The family reviewer decided this on 2026-11-12, by the family's rule of two consumers: a component moves to `ui` once two SDKs need it.

- **It's written to `ui`'s component contract,** from `ui`'s primitives, with its own CSS under `hm.sdk`, so it can move without being rewritten.
- **The trigger for promoting it** is audio-sdk's editor needing a clip track. Then it moves to `ui`, with an ADR there, and both SDKs render `ui`'s. Until then, video-sdk is its only user, and its design can change with each release here, without waiting for `ui`'s.

**Its arithmetic is `sdk-core`'s timeline helpers** ([ADR 0042](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0042-timeline-sequence-helpers.md)), from `sdk-core` 0.4.0, in output frames:

- **Layout:** `sequenceOffsets` of the clips' lengths gives every boundary, the clips' starts and the plan's length, for laying out the clips and the playhead.
- **The playhead and the pointer:** `locate` maps a frame to the clip under it and the frame within it, on every animation frame while playing, and for a pointer at the frame under it. A frame on a boundary belongs to the clip that starts there, and the plan's end, where no clip is, shows the last frame.
- **Snapping:** a dragged edge or the playhead snaps with `snap` to the clips' boundaries and the playhead. Its tolerance is in output frames, converted from a fixed distance of 8 CSS pixels at the current zoom: `Math.round(8 × framesPerPixel)`, where `framesPerPixel` is the visible length in frames divided by the timeline's width. So snapping feels the same at every zoom. `Alt` while dragging turns it off.
- **They replace this SDK's own `clipOffsets` and `locateFrame`** in the UI. The core's are kept, as they're public, and later reimplemented over the helpers.

- **The track is a `listbox`** of clips, horizontal, with `aria-multiselectable`. One tab stop, with roving focus: Left and Right move between clips, Home and End to the first and last, and the selection follows focus. Shift extends it from the last clip chosen; Mod moves focus without it, `Space` (or `Mod+Space`) adds or removes the focused clip, `Shift+Space` selects up to it, and `Mod+A` selects every clip. Space is the listbox's own key here: sdk-core's registry counts an option as a control, whose Space it never takes. A click selects, Shift-click extends and Mod-click toggles. In a right-to-left layout, Left and Right swap, as time runs leftward. Each clip's accessible name is its source's position and its range: "Clip 2 of 5, 0:04.00 to 0:09.20, muted".
- **The playhead is a `ui` Slider** over output frames, with `aria-valuetext` the time, so a screen reader reads "0:12.40" and not a frame number. Its arrow keys step one frame, and Page Up and Page Down one second, as the slider's own keys.
- **Every drag has a keyboard alternative:**

  | Drag | Keys, on a focused clip |
  |---|---|
  | Move a clip | `Alt+Left`, `Alt+Right` move it before or after its neighbour |
  | Trim its start or end | `[` and `]` set the start or end to the playhead; `Alt+[` and `Alt+]` move it a frame inward, shortening the clip, and `Alt+Shift+[` and `Alt+Shift+]` a frame outward |
  | Scrub | the playhead slider |

- **The bracket keys are matched by position,** `event.code`, not by character: `Alt` changes the character they type on Apple's layouts, and other layouts put brackets elsewhere.
- **Every drag has a single-pointer alternative too** (WCAG 2.5.7): the toolbar's trim buttons set the focused clip's start or end to the playhead, which a click on the track or the slider places. Moving a clip has no drag yet; when it gets one, its alternative is a button pair.
- **Zoom** is the family's `+`, `-` and `0`, without a modifier ([ADR 0030](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0030-tools-and-keyboard-shortcuts.md)), and `0` fits the plan to the track.
- **Scrolling** follows the playhead while playing, and the focused clip otherwise.

**As built** (the timeline's first release): the track, the playhead slider, the keys above, dragging an edge to trim, and the snap button. Zoom moved to the editor's tools, with `+`, `-` and `0`, and the timeline reads the editor's zoom: a multiple of fitting the plan, up to 48 px a frame. The waveform lane comes after it. An insert moves focus to the new clip only while focus is in the editor, or was lost from it, as when the drop zone goes: a host's insert on load doesn't take focus from the page.

### Tools and shortcuts

Each feature is a folder under `src/features/` with its command, UI, styles, messages and tests, registered with `defineTool` ([ADR 0009](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0009-features-as-tools.md)). The shortcut registry is created with the platform, and the editor listens on its root.

**As built** (the tools' first release):

- **The tools are headless definitions in `src/features/tools/`,** one module for now, with their state and context types. A feature gets its own folder when it has UI or styles of its own, such as the inspector's panels. The React layer binds them in `useVideoTools`, and `VideoToolbar` renders them in `ui`'s Toolbar. The provider's `tools` and `toolbar` props choose them as plain data.
- **The default toolbar** is adding videos, history, editing (split, delete, mute) and zoom. Playback's tools aren't on it, because the transport is their controls: its buttons carry the same tools' `aria-keyshortcuts` and tooltips, and their keys work everywhere in the editor. `video.export` comes with the export dialog.
- **The platform comes from `ui`'s `usePlatform()`,** so the server render and hydration use the other platform's keys, and Apple devices switch right after.
- **A tool that can't run stays in the toolbar's keyboard order,** with `aria-disabled`, through `ui`'s `focusableWhenDisabled`.
- **The tooltip is the native `title`** for now, such as "Undo (Ctrl+Z)" or "Undo (⌘Z)", with the keys from sdk-core's `keys.*` messages. `ui` has no tooltip yet; when it has one, the toolbar uses it.
- **The toolbar re-renders only when a tool's state changes,** not every frame while playing: the playhead is read on animation frames, and the tools' flags are compared before they're set.
- **Space plays, and the arrows step, while focus is in the editor on no control.** On a clip, Space selects, and on a button it presses the button. The stage is focusable by a click, not by Tab, so a click on the preview and then Space plays.
- **Undo and redo are announced** as "Undone" and "Redone". Naming what was undone, as "Undid split", needs the session to say which step it was, which it doesn't yet.
- **Focus after an edit,** as above: a split's second part, the clip that took a deleted one's place or the one before, and a clip that an undo restored.
- **One `Messages` object** for the SDK's text and `ui`'s, from the host's locale and `messages`, goes to `UiMessagesProvider` (sdk-core ADR 0046). A test checks that the SDK's own keys take none of `sdkCoreMessages`' or `uiMessages`'.

| Tool | Keys | Notes |
|---|---|---|
| `video.play-pause` | family `play-pause` (`Space`) | Not on fields or controls, so `Space` on a button presses it |
| `video.previous-frame`, `video.next-frame` | `Left`, `Right` | Not on controls, where arrows are the control's own. The timeline handles its own arrows first, to move between clips, and marks them handled, which the registry ignores |
| `video.start`, `video.end` | `Home`, `End` | The same rules |
| `video.split` | `S` | At the playhead |
| `video.delete` | family `delete` | The selected clips; deleting a range is the selection's own tool |
| `video.mute` | `M` | The selected clips |
| `video.undo`, `video.redo` | family `undo`, `redo` | |
| `video.zoom-in`, `video.zoom-out`, `video.zoom-fit` | family zoom | |
| `video.insert` | none | `Mod+O` is the browser's own |
| `video.export` | none | Irreversible, so a click, through the export dialog |

**Single-key shortcuts,** `S`, `M`, `[`, `]`, `+`, `-` and `0`, and the unmodified `Home`, `End`, `Left` and `Right`, are active only while focus is inside the editor's root ([ADR 0030](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0030-tools-and-keyboard-shortcuts.md)). That's WCAG 2.1.4's condition for character-key shortcuts that are active only while their component has focus. They never fire in a text field, `select` or `contenteditable`, whose keys are the field's own. Each tool's button carries `aria-keyshortcuts` from the registry, and its tooltip shows the keys from the catalogue. Tools that a host leaves out with `tools` have no keys either.

### Focus

Focus always lands somewhere meaningful, and never on `<body>`:

- **After an insert,** on the new clip. After an insert of several files, on the first.
- **After a split,** on the second half, which is where the playhead is.
- **After a delete,** on the clip that took the first deleted clip's place, or else the one before, or else the timeline's empty state.
- **After undo or redo,** on the clip the command changed, when there is one. An announcement says what was undone, such as "Undid split".
- **Dialogs** are `ui`'s native `<dialog>` with `showModal()`, which returns focus to the opener on close.
- **Export** runs in its dialog. The summary comes first, as the standards require for irreversible outputs; then progress, which can be cancelled; then a download button, which gets focus, and an announcement.

  **As built** (the export dialog's first release): the `video.export` tool, in the toolbar's File group with no shortcut, opens it.
  - **The summary:** the picture's size, the frame rate and length, the audio, and that nothing else from the source files is copied, only the metadata fields the plan sets.
  - **The choices:** a file type (automatic, MP4 or WebM) and a quality (smaller file, balanced or higher quality). The output's own settings belong to the inspector.
  - **While it runs:** a Stop button, and a status line when the file passes `maxFileSize`'s warning.
  - **When it's done:** Download, focused, and Done. A host's `onExport` takes the file instead, and the dialog closes.
  - **Closing:** whatever closes the dialog, or unmounts it, stops its export and resets it, and a result that arrives after that is dropped, as image-sdk's dialog does.
  - **The processor:** the host's `processor`, or the editor's own, made from the SDK's engine on the first export. With a host's engine and no processor, the dialog says export isn't available.
- **Announcements** go through `ui`'s Announcer, politely: inserts done or failed, export done, undo and redo, and audio blocked.

### The React API

- **`<VideoEditor>`** takes the family's props. `initialFiles` are inserted on mount; `file` and `onChange` are the controlled form, where `onChange` gets the plan after each committed command. Then `engine` and `processor`, which default to the SDK's own; `filePolicy`, `assetsUrl` (once `sdk-core` 0.3.0 is in), `tools`, `toolbar` and `features`, `theme`, `className`, `classNames`, `unstyled`, `messages` and `locale`, `icons`, `onEvent`, and `onExport`, which gets the `Blob` instead of the download.
- **The ref handle** has `insert(file)`, `export(job)`, `undo()`, `redo()`, `play()`, `pause()` and `seek(frame)`.
- **Building blocks:** `VideoStage`, `VideoTransport`, `VideoTimeline`, `VideoInspector`, `VideoToolbar` and `VideoExportDialog`, each usable inside a `VideoEditorProvider`.
- **Hooks:** `useVideoSession`, `useVideoOutput`, and `useVideoPlayhead`, which reads `position()` on animation frames while playing, and from the snapshot otherwise, so a component that shows the time re-renders at most once a frame, and nothing else does.
- **The entry starts with `"use client"`** and does nothing on import. On a server it renders the empty state's markup, with no canvas, engine or worker ([ADR 0007 in sdk-core](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0007-server-rendering-and-nextjs.md)).

### The element

`defineVideoEditorElement` is built with `createEditorElement`: kind `video`, the tag `hm-video-editor`, the attributes `theme`, `locale` and `tools`, the properties `file`, `filePolicy`, `assetsUrl`, `messages`, `engine` and `processor`, the ref handle's methods, and the events `change`, `event`, `export` and `error`. It mounts `<VideoEditor>` into the light DOM ([ADR 0040](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0040-editor-element-base.md)).

### Tests

- **axe** on every designed state, in all three engines.
- **Keyboard only, end to end:** insert through the drop zone's button, select clips, split, trim and move with the keys above, delete, undo, play and pause, step frames, and export. Each step checks where focus is.
- **Shortcuts** don't fire in fields or on controls, and `Space` on a button presses it.
- **StrictMode:** mounting, unmounting and mounting again leaves one output and one canvas, and the frame and audio ledgers at zero ([ADR 0002](0002-workers-and-assets.md)).
- **Server rendering:** the entry renders on a server, with no canvas.
- **The element:** attributes and properties reach the editor, a move keeps the session, and a removal tears it down.

### Order of the work

1. The React entry: the editor, its building blocks and hooks, with `ui` 0.3.0.
2. The element, with `sdk-core` 0.4.0.

## Alternatives considered

- **A timeline in `ui` from the start:** `ui` would carry a component with one user whose design isn't settled, and each change would wait for a `ui` release and a bump in every SDK ([ADR 0036](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0036-ui-as-a-dependency-of-the-sdks.md)). It moves when audio-sdk needs it, with two users to design for.
- **Rendering the canvas with React:** StrictMode's second mount would find the canvas already transferred, and fail.
- **Listening for shortcuts on `window`:** shortcuts would fire outside the editor, and single-character keys would break WCAG 2.1.4 ([ADR 0030](https://github.com/ie-huss-martinez/sdk-core/blob/main/docs/adr/0030-tools-and-keyboard-shortcuts.md)).
- **Trimming by drag only:** it leaves out keyboard and switch users, which WCAG 2.5.7 forbids.
- **Re-rendering on every playhead change:** sixty renders a second of the whole editor. Only the components that show the time subscribe to it.

## Consequences

- **Every action has a keyboard path, and a defined focus target,** which the end-to-end tests check step by step.
- **The timeline is ours to change until audio-sdk needs one.** Promoting it to `ui` then is a planned move, with its own ADR in `ui`.
- **The canvas's lifecycle is the effect's,** not React's, which is the one place the editor touches the DOM directly.
