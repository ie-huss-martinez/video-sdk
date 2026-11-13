import {
  createMessages,
  createShortcutRegistry,
  createToolRegistry,
  type MessageOverrides,
  type Messages,
  type ShortcutRegistry,
  type ToolRegistry,
} from "@hussmartinez/sdk-core";
import { uiMessages } from "@hussmartinez/ui";
import { usePlatform } from "@hussmartinez/ui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createVideoEngine } from "../adapters/video-engine.js";
import type { VideoFilePolicyOverrides } from "../core/errors/video-limits.js";
import type { VideoEngine } from "../core/ports/video-engine.js";
import type { VideoOutput, VideoOutputSnapshot } from "../core/ports/video-output.js";
import {
  createVideoSession,
  type VideoSession,
  type VideoSessionEvent,
  type VideoSessionSnapshot,
} from "../core/session/session.js";
import { defaultVideoToolbar, type VideoTool, videoTools } from "../features/tools/tools.js";
import { videoMessages } from "../messages/en.js";

/**
 * The editor's catalogue: the SDK's, and `ui`'s for its own components, as
 * one catalogue for one `Messages` object (sdk-core ADR 0046). A host
 * overrides `ui`'s text, such as `fileDropZone.choose`, through the same
 * `messages` prop.
 *
 * @internal
 */
export const editorCatalogue = { ...videoMessages, ...uiMessages };

/**
 * The text the editor uses: the SDK's catalogue with `ui`'s.
 *
 * @public
 */
export type VideoEditorMessages = Messages<typeof editorCatalogue>;

/**
 * A host's overrides of the editor's text, keyed as in `videoMessages`.
 *
 * @public
 */
export type VideoEditorMessageOverrides = MessageOverrides<typeof editorCatalogue>;

/**
 * Props of {@link VideoEditorProvider}.
 *
 * @public
 */
export interface VideoEditorProviderProps {
  /** Replaces the SDK's engine. The SDK's preview plays only from its own engine. */
  readonly engine?: VideoEngine;
  /** The limits files and edits are checked against. */
  readonly filePolicy?: VideoFilePolicyOverrides;
  /** Where the application serves the package's `dist/assets/`, to self-host the workers. */
  readonly assetsUrl?: string | URL;
  /** Text overrides. */
  readonly messages?: VideoEditorMessageOverrides;
  /** The locale numbers, sizes and times are formatted for. */
  readonly locale?: string;
  /** Anonymous usage events: never file names or contents. */
  readonly onEvent?: (event: VideoSessionEvent) => void;
  /**
   * Which tools are present, by id, in order, such as
   * `["video.undo", "video.redo", "video.split"]`. All of them by default. A
   * tool that's left out has no button and no shortcut.
   */
  readonly tools?: readonly string[];
  /**
   * The toolbar's groups, by tool id. By default: adding videos, history,
   * editing and zoom, from the present tools.
   */
  readonly toolbar?: readonly (readonly string[])[];
  readonly children?: ReactNode;
}

interface EditorContext {
  readonly engine: VideoEngine;
  readonly session: VideoSession;
  readonly messages: VideoEditorMessages;
  readonly locale: string | undefined;
  readonly filePolicy: VideoFilePolicyOverrides | undefined;
  readonly output: VideoOutput | null;
  readonly setOutput: (output: VideoOutput | null) => void;
  /** The clips selected in the timeline, by key, in plan order. */
  readonly selectedClips: readonly string[];
  readonly setSelectedClips: (keys: readonly string[]) => void;
  /** The timeline's zoom, as a multiple of fitting the whole plan. */
  readonly zoom: number;
  readonly setZoom: (zoom: number) => void;
  /** The closest zoom the timeline allows at its width. */
  readonly maxZoom: number;
  readonly setMaxZoom: (zoom: number) => void;
  /** The present tools, and the toolbar's groups of them. */
  readonly tools: ToolRegistry<VideoTool>;
  /** The present tools' shortcuts, for this platform. */
  readonly shortcuts: ShortcutRegistry;
  /** Adds files at the end, one after another, until cancelled. */
  readonly insertFiles: (files: readonly Blob[]) => void;
  /** Cancels the inserts in progress. */
  readonly cancelInsert: () => void;
  /** Where the toolbar registers its file picker, for the insert tool. */
  readonly fileChooser: { current: (() => void) | null };
}

/** The default toolbar, from the present tools only. */
function toolbarOf(present: readonly string[] | undefined): readonly (readonly string[])[] {
  if (!present) return defaultVideoToolbar;
  const ids = new Set(present);
  return defaultVideoToolbar
    .map((group) => group.filter((id) => ids.has(id)))
    .filter((group) => group.length > 0);
}

const Context = /* @__PURE__ */ createContext<EditorContext | null>(null);

/**
 * Holds one editing session, its engine and its text, for the editor's
 * building blocks (docs/adr/0007). It creates the SDK's engine unless one is
 * given, and releases both when it unmounts. A remount within the same
 * task, as React's StrictMode does, keeps them.
 *
 * @public
 */
export function VideoEditorProvider(props: VideoEditorProviderProps): ReactNode {
  const { engine: given, assetsUrl, filePolicy, locale } = props;
  const onEvent = useRef(props.onEvent);
  onEvent.current = props.onEvent;
  const [engine] = useState(() => given ?? createVideoEngine(assetsUrl ? { assetsUrl } : {}));
  const [session] = useState(() =>
    createVideoSession({
      engine,
      ...(filePolicy ? { filePolicy } : {}),
      onEvent: (event) => onEvent.current?.(event),
    }),
  );
  const [output, setOutput] = useState<VideoOutput | null>(null);
  const [selectedClips, setSelectedClips] = useState<readonly string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);
  const fileChooser = useRef<(() => void) | null>(null);
  const inserts = useRef(new Set<AbortController>());
  const mounts = useRef(0);
  const platform = usePlatform();

  // The props are plain data, often written inline: compare them by value.
  const toolsKey = JSON.stringify(props.tools ?? null);
  const toolbarKey = JSON.stringify(props.toolbar ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: by value, through the keys
  const tools = useMemo(
    () =>
      createToolRegistry(videoTools, {
        ...(props.tools ? { tools: props.tools } : {}),
        toolbar: props.toolbar ?? toolbarOf(props.tools),
      }),
    [toolsKey, toolbarKey],
  );
  const shortcuts = useMemo(
    () => createShortcutRegistry({ platform, tools: tools.tools }),
    [platform, tools],
  );

  const insertFiles = useCallback(
    (files: readonly Blob[]) => {
      const controller = new AbortController();
      inserts.current.add(controller);
      void (async () => {
        try {
          for (const file of files) {
            if (controller.signal.aborted) return;
            // A failure is in the session's snapshot, which the stage shows.
            await session.insert(file, { signal: controller.signal }).catch(() => {});
          }
        } finally {
          inserts.current.delete(controller);
        }
      })();
    },
    [session],
  );
  const cancelInsert = useCallback(() => {
    for (const controller of inserts.current) controller.abort();
  }, []);

  useEffect(() => {
    const mount = ++mounts.current;
    return () => {
      // StrictMode unmounts and mounts again at once; only a real unmount releases.
      queueMicrotask(() => {
        if (mounts.current !== mount) return;
        void session.destroy();
        if (!given) void engine.destroy();
      });
    };
  }, [engine, given, session]);

  const messages = useMemo(
    () =>
      // One object for the SDK's text and ui's (sdk-core ADR 0046). A host's
      // overrides are checked for unknown keys and placeholders here.
      createMessages(editorCatalogue, {
        ...(locale ? { locale } : {}),
        ...(props.messages ? { overrides: props.messages } : {}),
      }),
    [locale, props.messages],
  );

  const value = useMemo(
    () => ({
      engine,
      session,
      messages,
      locale,
      filePolicy,
      output,
      setOutput,
      selectedClips,
      setSelectedClips,
      zoom,
      setZoom,
      maxZoom,
      setMaxZoom,
      tools,
      shortcuts,
      insertFiles,
      cancelInsert,
      fileChooser,
    }),
    [
      engine,
      session,
      messages,
      locale,
      filePolicy,
      output,
      selectedClips,
      zoom,
      maxZoom,
      tools,
      shortcuts,
      insertFiles,
      cancelInsert,
    ],
  );
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

/**
 * The editor's session, engine, text and output, from the nearest
 * {@link VideoEditorProvider}.
 *
 * @internal
 */
export function useVideoEditor(): EditorContext {
  const context = useContext(Context);
  if (!context) throw new TypeError("Video editor components need a VideoEditorProvider.");
  return context;
}

/**
 * The editing session and its snapshot, which changes with every edit.
 *
 * @public
 */
export function useVideoSession(): {
  readonly session: VideoSession;
  readonly snapshot: VideoSessionSnapshot;
} {
  const { session } = useVideoEditor();
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  return { session, snapshot };
}

const noSubscription = () => () => {};
const noSnapshot = () => null;

/**
 * The preview's output and its snapshot, or `null` before the stage has
 * mounted one.
 *
 * @public
 */
export function useVideoOutput(): {
  readonly output: VideoOutput | null;
  readonly snapshot: VideoOutputSnapshot | null;
} {
  const { output } = useVideoEditor();
  const snapshot = useSyncExternalStore(
    output ? output.subscribe : noSubscription,
    output ? output.getSnapshot : noSnapshot,
    noSnapshot,
  );
  return { output, snapshot };
}

/**
 * The playhead, in output frames, read on each animation frame. A component
 * re-renders only when the frame changes, so only components that show the
 * time follow it (docs/adr/0007).
 *
 * @public
 */
export function useVideoPlayhead(): number {
  const { output } = useVideoOutput();
  const [frame, setFrame] = useState(() => output?.position() ?? 0);
  useEffect(() => {
    if (!output) return;
    // Seeks and steps change no snapshot field, so the playhead is read on
    // each animation frame; setting the same frame doesn't re-render.
    let pending = requestAnimationFrame(function read() {
      setFrame(output.position());
      pending = requestAnimationFrame(read);
    });
    return () => cancelAnimationFrame(pending);
  }, [output]);
  return frame;
}
