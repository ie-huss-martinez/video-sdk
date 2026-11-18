import { AnnouncerProvider, UiMessagesProvider } from "@hussmartinez/ui/react";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef } from "react";
import type { VideoSourceInfo } from "../core/model/source.js";
import type { VideoExportResult } from "../core/ports/video-processor.js";
import { useVideoEditor, VideoEditorProvider, type VideoEditorProviderProps } from "./context.js";
import { useVideoTools } from "./tools.js";
import { VideoExportDialog, type VideoExportDialogProps } from "./VideoExportDialog.js";
import { VideoInspector } from "./VideoInspector.js";
import { VideoStage } from "./VideoStage.js";
import { VideoTimeline } from "./VideoTimeline.js";
import { VideoToolbar } from "./VideoToolbar.js";
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
  /**
   * The name an export is downloaded under, without its extension, such as
   * the name of the file being edited. Without it, the video's title is
   * used, or else `video`. See {@link VideoExportDialogProps.fileName}.
   */
  readonly fileName?: string;
  /**
   * Takes an export's file instead of the download, such as to upload it or
   * save it the host's own way. The export dialog closes once it's called.
   * See {@link VideoExportDialogProps.onExport}.
   */
  readonly onExport?: (blob: Blob, result: VideoExportResult) => void;
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
  {
    readonly initialFiles?: readonly Blob[];
    readonly className?: string;
    readonly fileName?: string;
    readonly onExport?: (blob: Blob, result: VideoExportResult) => void;
  }
>(function Shell({ initialFiles, className, fileName, onExport }, ref) {
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
    // One Messages object for the SDK's text and ui's (sdk-core ADR 0046).
    <UiMessagesProvider messages={messages}>
      <AnnouncerProvider>
        <Root className={className} fileName={fileName} onExport={onExport} />
      </AnnouncerProvider>
    </UiMessagesProvider>
  );
});

/**
 * The editor's root. Its tools' shortcuts are matched here, on the root and
 * never on `window`, so they apply only while focus is in the editor, as
 * WCAG 2.1.4 requires of single-key shortcuts (sdk-core ADR 0030).
 */
function Root({
  className,
  fileName,
  onExport,
}: {
  readonly className?: string | undefined;
  readonly fileName?: string | undefined;
  readonly onExport?: ((blob: Blob, result: VideoExportResult) => void) | undefined;
}): ReactNode {
  const { messages, shortcuts } = useVideoEditor();
  const { run } = useVideoTools();
  return (
    <section
      // hm-text gives the editor's own text ui's type and colour, whatever
      // the host page sets around it (ui ADR 0010).
      className={["hm-text", "hm-video-editor", className].filter(Boolean).join(" ")}
      aria-label={messages.t("editor.label")}
      onKeyDown={(event) => {
        // The registry skips handled keys, fields, and a control's own keys.
        // The root is this section, not React's container: a host's modal
        // dialog around the editor then doesn't silence it (sdk-core 0.4.2).
        const id = shortcuts.match(event.nativeEvent, { root: event.currentTarget });
        if (id && run(id)) event.preventDefault();
      }}
    >
      <VideoToolbar />
      <VideoStage />
      <VideoTransport />
      <VideoTimeline />
      <VideoInspector />
      <VideoExportDialog
        {...(fileName === undefined ? {} : { fileName })}
        {...(onExport ? { onExport } : {})}
      />
    </section>
  );
}

/**
 * The video editor (docs/adr/0007): the toolbar, the preview, its playback
 * controls, the timeline and the inspector, over one editing session, with
 * the tools' keyboard shortcuts while focus is in it. The `tools` and
 * `toolbar` props choose the tools, as plain data.
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
  function VideoEditor(
    { initialFiles, className, fileName, onExport, ...provider },
    ref,
  ): ReactNode {
    return (
      <VideoEditorProvider {...provider}>
        <Shell
          ref={ref}
          {...(initialFiles ? { initialFiles } : {})}
          {...(className ? { className } : {})}
          {...(fileName === undefined ? {} : { fileName })}
          {...(onExport ? { onExport } : {})}
        />
      </VideoEditorProvider>
    );
  },
);
