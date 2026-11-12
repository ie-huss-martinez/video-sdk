import type { VideoContainer } from "../../core/model/source.js";

/**
 * What the front check learned about a file, before mediabunny reads it
 * (ADR 0001).
 *
 * @internal
 */
export interface FrontCheck {
  readonly container: VideoContainer;
  /** Which of mediabunny's readers may read it. */
  readonly family: "isobmff" | "matroska";
  /** The bytes of the file's index, which `maxIndexSize` bounds. */
  readonly indexSize: number;
  /** Every track, of every kind. */
  readonly tracks: number;
}
