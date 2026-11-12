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
export { dbToGain, gainAt } from "./core/model/envelope.js";
export type {
  VideoClip,
  VideoCrop,
  VideoFade,
  VideoFadeCurve,
  VideoFit,
  VideoMetadata,
  VideoPlan,
  VideoPlanOutput,
  VideoTransform,
} from "./core/model/plan.js";
export {
  clipEnd,
  clipFrames,
  clipOffsets,
  createPlan,
  EMPTY_METADATA,
  IDENTITY_TRANSFORM,
  locateFrame,
  MAX_METADATA_LENGTH,
  NO_FADE,
  outputFromSource,
  planFrames,
  snapFrameRate,
  VOLUME_RANGE,
} from "./core/model/plan.js";
export { checkProbe, decodingBound } from "./core/model/probe-limits.js";
export type {
  AudioTrackProbe,
  VideoContainer,
  VideoProbe,
  VideoRotation,
  VideoSourceInfo,
  VideoTrackProbe,
} from "./core/model/source.js";
export { addRotations, rotateSize, sourceInfo } from "./core/model/source.js";
export type { FrameRate } from "./core/model/time.js";
export {
  framesIn,
  frameTime,
  isFrameRate,
  isOnGrid,
  microsecondsToSeconds,
  secondsToMicroseconds,
} from "./core/model/time.js";
export type {
  DeleteRangeCommand,
  InsertClipsCommand,
  MoveClipsCommand,
  RemoveClipsCommand,
  RestoreClipsCommand,
  SetFadeCommand,
  SetMetadataCommand,
  SetMutedCommand,
  SetOutputCommand,
  SetTransformCommand,
  SetVolumeCommand,
  SplitClipCommand,
  TrimClipCommand,
  VideoClipEntry,
  VideoCommand,
} from "./core/operations/commands.js";
export { createVideoReducer } from "./core/operations/commands.js";
export type { Applied, Reducer } from "./core/operations/reducer-types.js";
export type {
  VideoCallOptions,
  VideoProbeOptions,
  VideoProgressOptions,
} from "./core/ports/options.js";
export type { VideoEngine } from "./core/ports/video-engine.js";
export type {
  VideoOutput,
  VideoOutputSnapshot,
  VideoOutputState,
} from "./core/ports/video-output.js";
export type {
  VideoExportContainer,
  VideoExportJob,
  VideoExportQuality,
  VideoProcessor,
} from "./core/ports/video-processor.js";
export type { VideoMessageCatalogue } from "./messages/en.js";
export { videoMessages } from "./messages/en.js";
