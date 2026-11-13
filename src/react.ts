"use client";

/**
 * React editor of the video SDK: `VideoEditor`, its building blocks and hooks.
 *
 * @remarks
 * A client entry: it starts with `"use client"`, which the build keeps
 * (ADR 0007). React and React DOM 18.3 or later are optional peer
 * dependencies. Import `@hussmartinez/ui/styles.css` and then this
 * package's `styles.css` once in the application: `ui`'s stylesheet carries
 * the focus rings and target sizes the editor's controls need.
 *
 * @packageDocumentation
 */

export type {
  VideoEditorMessageOverrides,
  VideoEditorMessages,
  VideoEditorProviderProps,
} from "./react/context.js";
export {
  useVideoOutput,
  useVideoPlayhead,
  useVideoSession,
  VideoEditorProvider,
} from "./react/context.js";
export type { VideoEditorHandle, VideoEditorProps } from "./react/VideoEditor.js";
export { VideoEditor } from "./react/VideoEditor.js";
export type {
  VideoExportDialogProps,
  VideoExportResult,
} from "./react/VideoExportDialog.js";
export { VideoExportDialog } from "./react/VideoExportDialog.js";
export type { VideoStageProps } from "./react/VideoStage.js";
export { VideoStage } from "./react/VideoStage.js";
export type { VideoTimelineProps } from "./react/VideoTimeline.js";
export { VideoTimeline } from "./react/VideoTimeline.js";
export type { VideoToolbarProps } from "./react/VideoToolbar.js";
export { VideoToolbar } from "./react/VideoToolbar.js";
export type { VideoTransportProps } from "./react/VideoTransport.js";
export { VideoTransport } from "./react/VideoTransport.js";
