import type { EditorElementContext, MountedEditor } from "@hussmartinez/sdk-core/element";
import { type ReactNode, type RefCallback, useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { VideoError } from "../../core/errors/video-error.js";
import type { VideoFilePolicyOverrides } from "../../core/errors/video-limits.js";
import type { VideoSourceInfo } from "../../core/model/source.js";
import type { VideoEngine } from "../../core/ports/video-engine.js";
import type { VideoExportResult, VideoProcessor } from "../../core/ports/video-processor.js";
import type { VideoSessionExportOptions } from "../../core/session/session.js";
import type { VideoEditorMessageOverrides } from "../../messages/editor.js";
import { VideoEditor, type VideoEditorHandle } from "../VideoEditor.js";
import { ElementListenersContext, type VideoExportReport } from "./listeners.js";

/**
 * The `<hm-video-editor>` element's props: its attributes, `theme`, `locale`
 * and `tools`, and its properties (docs/adr/0007). They're writable, since a
 * host sets them on the element, such as `editor.file = file`.
 *
 * @public
 */
export interface VideoEditorElementProps {
  /** `light`, `dark` or `system`: ui's colour mode, on the element. Inherited when unset. */
  theme?: string;
  /** The locale for numbers and plurals. Defaults to `"en"`. */
  locale?: string;
  /** Which tools are present, by id, in order: the attribute is space-separated. */
  tools?: readonly string[];
  /**
   * A video to open. Setting another opens it, replacing the plan, and a
   * failure keeps the plan, is shown in the editor and fires `error`.
   * `insert()` adds more files to the plan.
   */
  file?: Blob;
  /** The name an export is downloaded under, without its extension. */
  fileName?: string;
  filePolicy?: VideoFilePolicyOverrides;
  /** Where the application serves the package's `dist/assets/` directory. */
  assetsUrl?: string | URL;
  /** Text overrides, typed against the English catalogue. */
  messages?: VideoEditorMessageOverrides;
  engine?: VideoEngine;
  processor?: VideoProcessor;
}

/**
 * The `<hm-video-editor>` element's methods, the React editor's ref handle's
 * own (docs/adr/0007). `open()`, `insert()` and `export()` wait for the
 * editor's first render, and `play()` for its preview; if the element is
 * removed first, they reject with `ABORTED` and `details.reason: "removed"`.
 * The others act on the editor there is, and do nothing before it. It's
 * written out from the main entry's types, not picked
 * from the React handle, so the element's API report copies nothing the main
 * entry doesn't export (sdk-core ADR 0033).
 *
 * @public
 */
export interface VideoEditorElementMethods {
  /**
   * Opens a file in place of the plan, as one clip, and clears the history.
   * A failed open keeps the plan.
   */
  open(file: Blob): Promise<VideoSourceInfo>;
  /** Inserts a file at the end of the plan, or at a frame. */
  insert(file: Blob, at?: number): Promise<VideoSourceInfo>;
  /** Exports the plan as it is now, without the dialog, as the handle's `export`. */
  export(options?: VideoSessionExportOptions): Promise<VideoExportResult>;
  /** Undoes the last edit; `false` when there's none, or before the first render. */
  undo(): boolean;
  /** Redoes the last undone edit; `false` when there's none, or before the first render. */
  redo(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(frame: number): void;
}

/**
 * The element's events, fired as `hm-video-editor-<name>`. None carries a
 * file name or contents (sdk-core ADR 0012):
 *
 * - `change`: the plan, after each open, insert, edit, undo or redo.
 * - `event`: the session's anonymous usage event.
 * - `export`: a {@link VideoExportReport} after the export dialog finishes.
 * - `error`: `{ code, details }` of a failure the editor shows.
 *
 * @public
 */
export type VideoEditorElementEvent = "change" | "event" | "export" | "error";

const MODES = new Set(["light", "dark", "system"]);

interface ElementEditorProps {
  readonly values: Partial<VideoEditorElementProps>;
  readonly onPlayable: () => void;
  readonly setHandle: RefCallback<VideoEditorHandle>;
  readonly handle: { readonly current: VideoEditorHandle | null };
  readonly dispatch: EditorElementContext<VideoEditorElementEvent>["dispatch"];
}

function ElementEditor(props: ElementEditorProps): ReactNode {
  const { values, setHandle, handle, dispatch, onPlayable } = props;
  const { file, theme: _theme, ...editorProps } = values;

  // A file is opened when it's set, replacing the plan. A failure is the
  // editor's to show, and the element's `error` event.
  const opened = useRef<Blob | undefined>(undefined);
  useEffect(() => {
    if (!file || file === opened.current) return;
    opened.current = file;
    handle.current?.open(file).catch(() => {});
  }, [file, handle]);

  const listeners = useMemo(
    () => ({
      onChange: (plan: unknown) => dispatch("change", plan),
      onExport: (report: VideoExportReport) => dispatch("export", report),
      onError: (error: { code: string; details: Readonly<Record<string, unknown>> }) =>
        dispatch("error", error),
      onPlayable,
    }),
    [dispatch, onPlayable],
  );

  return (
    <ElementListenersContext.Provider value={listeners}>
      <VideoEditor ref={setHandle} {...editorProps} onEvent={(event) => dispatch("event", event)} />
    </ElementListenersContext.Provider>
  );
}

/** A promise and its settlers. Nobody may wait on it, so its rejection is handled. */
function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: () => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = () => done();
    reject = fail;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** What a call waiting on an editor that was removed rejects with. */
const removed = (): VideoError =>
  new VideoError("ABORTED", "The element was removed before its editor was ready.", {
    details: { reason: "removed" },
  });

/**
 * Renders `<VideoEditor>` into the element's light DOM, for
 * `createEditorElement` (sdk-core ADR 0040), as audio-sdk's and image-sdk's
 * elements do. It renders without `flushSync`, since the element may connect
 * during a host's React commit; so `open()`, `insert()` and `export()` wait
 * for the first render, `play()` for the preview's output, and the others act
 * on the editor there is. A removal before then rejects them with `ABORTED`
 * and `details.reason: "removed"`.
 */
export function mountVideoEditor(
  host: HTMLElement,
  initial: Partial<VideoEditorElementProps>,
  context: EditorElementContext<VideoEditorElementEvent>,
): MountedEditor<Partial<VideoEditorElementProps>, VideoEditorElementMethods> {
  const root = createRoot(host);
  const handle: { current: VideoEditorHandle | null } = { current: null };
  // The first render, and the preview's output after it. A removal before
  // either rejects the calls waiting for it, which would otherwise never
  // settle.
  const rendered = deferred();
  const playable = deferred();
  const setHandle: RefCallback<VideoEditorHandle> = (editor) => {
    handle.current = editor;
    if (editor) rendered.resolve();
  };
  const dispatch = context.dispatch;

  const render = (values: Partial<VideoEditorElementProps>) => {
    // The colour mode is ui's attribute on the element itself, so changing it
    // never re-renders the editor.
    const mode = values.theme;
    if (mode && MODES.has(mode)) host.setAttribute("data-hm-theme", mode);
    else host.removeAttribute("data-hm-theme");
    root.render(
      <ElementEditor
        values={values}
        setHandle={setHandle}
        handle={handle}
        dispatch={dispatch}
        onPlayable={playable.resolve}
      />,
    );
  };
  render(initial);

  const now = (): VideoEditorHandle | null => handle.current;
  // The handle there is once it's ready: each render renews it, and the
  // first one's `play` has no output yet.
  const after = async (ready: Promise<void>): Promise<VideoEditorHandle> => {
    await ready;
    const editor = now();
    if (!editor) throw removed();
    return editor;
  };
  return {
    update: render,
    unmount: () => {
      root.unmount();
      host.removeAttribute("data-hm-theme");
      rendered.reject(removed());
      playable.reject(removed());
    },
    handle: {
      open: async (file) => (await after(rendered.promise)).open(file),
      insert: async (file, at) => (await after(rendered.promise)).insert(file, at),
      export: async (options) => (await after(rendered.promise)).export(options),
      undo: () => now()?.undo() ?? false,
      redo: () => now()?.redo() ?? false,
      play: async () => (await after(playable.promise)).play(),
      pause: () => now()?.pause(),
      seek: (frame) => now()?.seek(frame),
    },
  };
}
