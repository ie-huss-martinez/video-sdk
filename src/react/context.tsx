import { createMessages, type MessageOverrides, type Messages } from "@hussmartinez/sdk-core";
import { uiMessages } from "@hussmartinez/ui";
import {
  createContext,
  type ReactNode,
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
import { videoMessages } from "../messages/en.js";

/** The editor's catalogue: the SDK's, and `ui`'s for its own components. */
const editorCatalogue = { ...videoMessages, ...uiMessages };

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
  const mounts = useRef(0);

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
      // A host's overrides are checked for unknown keys and placeholders
      // when they're created; as a prop they're only known to be overrides.
      createMessages(editorCatalogue, {
        ...(locale ? { locale } : {}),
        ...(props.messages ? { overrides: props.messages } : {}),
      } as never) as VideoEditorMessages,
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
    }),
    [engine, session, messages, locale, filePolicy, output, selectedClips],
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
