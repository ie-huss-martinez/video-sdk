import { AnnouncerProvider, UiMessagesProvider } from "@hussmartinez/ui/react";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef } from "react";
import type { VideoSourceInfo } from "../core/model/source.js";
import { useVideoEditor, VideoEditorProvider, type VideoEditorProviderProps } from "./context.js";
import { VideoStage } from "./VideoStage.js";
import { VideoTimeline } from "./VideoTimeline.js";
import { VideoTransport } from "./VideoTransport.js";

/**
 * Props of {@link VideoEditor}.
 *
 * @public
 */
export interface VideoEditorProps extends Omit<VideoEditorProviderProps, "children"> {
  /** Files inserted when the editor mounts, in order. */
  readonly initialFiles?: readonly Blob[];
  /** Extra classes on the root. */
  readonly className?: string;
}

/**
 * What a host can do with the editor through its ref.
 *
 * @public
 */
export interface VideoEditorHandle {
  /** Inserts a file at the end of the plan, or at a frame. */
  insert(file: Blob, at?: number): Promise<VideoSourceInfo>;
  undo(): boolean;
  redo(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(frame: number): void;
}

const Shell = forwardRef<
  VideoEditorHandle,
  { readonly initialFiles?: readonly Blob[]; readonly className?: string }
>(function Shell({ initialFiles, className }, ref) {
  const { session, messages, output } = useVideoEditor();
  const inserted = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      insert: (file, at) => session.insert(file, at === undefined ? {} : { at }),
      undo: () => session.undo(),
      redo: () => session.redo(),
      play: async () => output?.play(),
      pause: () => output?.pause(),
      seek: (frame) => output?.seek(frame),
    }),
    [session, output],
  );

  useEffect(() => {
    if (inserted.current || !initialFiles?.length) return;
    inserted.current = true;
    void (async () => {
      for (const file of initialFiles) await session.insert(file).catch(() => {});
    })();
  }, [initialFiles, session]);

  return (
    <UiMessagesProvider messages={messages}>
      <AnnouncerProvider>
        <section
          className={["hm-video-editor", className].filter(Boolean).join(" ")}
          aria-label={messages.t("editor.label")}
        >
          <VideoStage />
          <VideoTransport />
          <VideoTimeline />
        </section>
      </AnnouncerProvider>
    </UiMessagesProvider>
  );
});

/**
 * The video editor (docs/adr/0007): the preview, its playback controls and
 * the timeline, over one editing session. The inspector, the toolbar and
 * export join it in later releases.
 *
 * @example
 * ```tsx
 * import "@hussmartinez/ui/styles.css";
 * import "@hussmartinez/video-sdk/styles.css";
 * import { VideoEditor } from "@hussmartinez/video-sdk/react";
 *
 * <VideoEditor initialFiles={[file]} onEvent={(event) => console.log(event.type)} />
 * ```
 *
 * @public
 */
export const VideoEditor = /* @__PURE__ */ forwardRef<VideoEditorHandle, VideoEditorProps>(
  function VideoEditor({ initialFiles, className, ...provider }, ref): ReactNode {
    return (
      <VideoEditorProvider {...provider}>
        <Shell
          ref={ref}
          {...(initialFiles ? { initialFiles } : {})}
          {...(className ? { className } : {})}
        />
      </VideoEditorProvider>
    );
  },
);
