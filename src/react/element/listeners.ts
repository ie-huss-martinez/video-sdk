import { createContext } from "react";
import type { VideoErrorCode } from "../../core/errors/video-error.js";
import type { VideoPlan } from "../../core/model/plan.js";
import type { VideoExportContainer } from "../../core/ports/video-processor.js";

/**
 * What the export dialog reports when an export finishes: the container,
 * the file's size and what clamping did to its sound, with no file name or
 * contents (sdk-core ADR 0012). The element fires it as its `export` event.
 *
 * @public
 */
export interface VideoExportReport {
  readonly container: VideoExportContainer;
  /** The file's size in bytes. */
  readonly size: number;
  /** The mix's peak before clamping, in dB relative to full scale. */
  readonly peakDb: number;
  /** How many audio frames were clamped to full scale. */
  readonly clippedFrames: number;
}

/**
 * What the element listens to inside the editor, without props on the
 * public components (docs/adr/0007), as audio-sdk's element does: the plan
 * as it changes, an export the dialog finished, a failure the editor shows,
 * and when the preview has settled, with its output or knowing it has none,
 * so `play()` can wait for it.
 *
 * @internal
 */
export interface ElementListeners {
  readonly onChange?: (plan: VideoPlan) => void;
  readonly onExport?: (report: VideoExportReport) => void;
  readonly onError?: (error: {
    readonly code: VideoErrorCode;
    readonly details: Readonly<Record<string, unknown>>;
  }) => void;
  readonly onPreviewSettled?: () => void;
}

/** @internal */
export const ElementListenersContext = createContext<ElementListeners>({});
