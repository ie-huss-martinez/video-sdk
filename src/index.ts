/**
 * Headless core of the video SDK: contracts, errors, the document session and
 * operations.
 *
 * @remarks
 * This entry is server-safe: it has no React and touches no DOM on import, so
 * Server Components and Node can import it (ADR 0004, ADR 0007).
 *
 * @packageDocumentation
 */

export type { VideoErrorCode } from "./core/errors/video-error.js";
export { isVideoError, VideoError } from "./core/errors/video-error.js";
export type {
  VideoFilePolicy,
  VideoFilePolicyOverrides,
  VideoLimitDefinitions,
  VideoLimitName,
} from "./core/errors/video-limits.js";
export { videoLimitDefinitions, videoLimits } from "./core/errors/video-limits.js";
export type { VideoMessageCatalogue } from "./messages/en.js";
export { videoMessages } from "./messages/en.js";
