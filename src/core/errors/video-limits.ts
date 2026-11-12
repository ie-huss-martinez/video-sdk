import {
  coreLimits,
  defineLimits,
  type FilePolicy,
  type FilePolicyOverrides,
  type Limits,
} from "@hussmartinez/sdk-core";
import { VideoError } from "./video-error.js";

/**
 * The video SDK's limit definitions: sdk-core's core limits with video
 * defaults, plus eleven for video (ADR 0004).
 *
 * | Limit | Code | Default maximum | Default warning |
 * |---|---|---|---|
 * | `maxFileSize` | `FILE_TOO_LARGE` | 4 GB | 1 GB |
 * | `maxFiles` | `TOO_MANY_FILES` | 20 | none |
 * | `maxDecodedSize` | `DECODED_SIZE_TOO_LARGE` | 1 GB | 400 MB |
 * | `maxProcessingTime` | `PROCESSING_TIME_EXCEEDED` | 120 s | none |
 * | `maxFramePixels` | `FRAME_TOO_LARGE` | 3840 × 2160 | 2560 × 1440 |
 * | `maxFrameRate` | `FRAME_RATE_TOO_HIGH` | 120 per second | none |
 * | `maxDuration` | `DURATION_TOO_LONG` | 3 hours | 1 hour |
 * | `maxBitrate` | `BITRATE_TOO_HIGH` | 200 Mbit/s | none |
 * | `maxPacketSize` | `PACKET_TOO_LARGE` | 32 MB | none |
 * | `maxTracks` | `TOO_MANY_TRACKS` | 16 | none |
 * | `maxIndexSize` | `INDEX_TOO_LARGE` | 64 MB | none |
 * | `maxChannels` | `TOO_MANY_CHANNELS` | 8 | none |
 * | `maxSampleRate` | `SAMPLE_RATE_TOO_HIGH` | 192 kHz | none |
 * | `maxSessionSize` | `SESSION_TOO_LARGE` | 512 MB | 256 MB |
 * | `maxClips` | `TOO_MANY_CLIPS` | 2,000 | none |
 *
 * Sizes are decimal: 1 MB is 1,000,000 bytes. `maxFramePixels` is a frame's
 * width × height, checked on every decoded frame. `maxDecodedSize` bounds
 * what decoding one file holds at once, not its total, because decoded media
 * is streamed. `maxSessionSize` counts the session's caches, such as
 * thumbnails and waveform peaks. `maxBitrate` is in bits per second, and
 * `maxDuration` in milliseconds. `maxDuration`, `maxChannels`,
 * `maxSampleRate`, `maxSessionSize` and `maxClips` have the same names and
 * codes as `@hussmartinez/audio-sdk`'s.
 *
 * @public
 */
export const videoLimitDefinitions = {
  ...coreLimits,
  maxFileSize: { ...coreLimits.maxFileSize, default: 4_000_000_000, warning: 1_000_000_000 },
  maxDecodedSize: { ...coreLimits.maxDecodedSize, default: 1_000_000_000, warning: 400_000_000 },
  maxFramePixels: {
    code: "FRAME_TOO_LARGE",
    unit: "pixels",
    default: 3840 * 2160,
    warning: 2560 * 1440,
  },
  // TODO(sdk-core 0.3.0): use the "hertz" unit (sdk-core ADR 0032) once a
  // fixed 0.3.0 is published, as ADR 0004 records.
  maxFrameRate: { code: "FRAME_RATE_TOO_HIGH", unit: "count", default: 120 },
  maxDuration: {
    code: "DURATION_TOO_LONG",
    unit: "milliseconds",
    default: 3 * 60 * 60 * 1000,
    warning: 60 * 60 * 1000,
  },
  // TODO(sdk-core): use a bits-per-second unit once sdk-core has one; the
  // value is in bits per second (ADR 0004).
  maxBitrate: { code: "BITRATE_TOO_HIGH", unit: "count", default: 200_000_000 },
  maxPacketSize: { code: "PACKET_TOO_LARGE", unit: "bytes", default: 32_000_000 },
  maxTracks: { code: "TOO_MANY_TRACKS", unit: "count", default: 16 },
  maxIndexSize: { code: "INDEX_TOO_LARGE", unit: "bytes", default: 64_000_000 },
  maxChannels: { code: "TOO_MANY_CHANNELS", unit: "count", default: 8 },
  // TODO(sdk-core 0.3.0): use the "hertz" unit (sdk-core ADR 0032) once a
  // fixed 0.3.0 is published, as ADR 0004 records.
  maxSampleRate: { code: "SAMPLE_RATE_TOO_HIGH", unit: "count", default: 192_000 },
  maxSessionSize: {
    code: "SESSION_TOO_LARGE",
    unit: "bytes",
    default: 512_000_000,
    warning: 256_000_000,
  },
  maxClips: { code: "TOO_MANY_CLIPS", unit: "count", default: 2_000 },
} as const;

/**
 * The type of {@link videoLimitDefinitions}.
 *
 * @public
 */
export type VideoLimitDefinitions = typeof videoLimitDefinitions;

/**
 * The names of the video SDK's limits.
 *
 * @public
 */
export type VideoLimitName = keyof VideoLimitDefinitions;

/**
 * A host's `filePolicy`: a new maximum, or `{ maximum, warning }`, for any of
 * the video SDK's limits. `Infinity` disables a maximum, which removes a
 * protection against hostile files, or disables a warning. Unknown limit
 * names throw `TypeError` when the policy is resolved.
 *
 * @example
 * ```ts
 * // 8K footage on desktops: raise the frame and decoded sizes together.
 * const filePolicy: VideoFilePolicyOverrides = {
 *   maxFramePixels: 7680 * 4320,
 *   maxDecodedSize: { maximum: 4e9, warning: 1.5e9 },
 * };
 * ```
 *
 * @public
 */
export type VideoFilePolicyOverrides = FilePolicyOverrides<VideoLimitDefinitions>;

/**
 * A resolved file policy for the video SDK. Violations throw
 * {@link VideoError}.
 *
 * @public
 */
export type VideoFilePolicy = FilePolicy<VideoLimitDefinitions>;

/**
 * The video SDK's limits, ready to resolve a host's `filePolicy`. Violations
 * are thrown as {@link VideoError}, with `details` naming the limit.
 *
 * @example
 * ```ts
 * const policy = videoLimits.resolve(props.filePolicy);
 * policy.check("maxFramePixels", codedWidth * codedHeight); // throws VideoError("FRAME_TOO_LARGE") above 4K
 * ```
 *
 * @public
 */
export const videoLimits: Limits<VideoLimitDefinitions> = /* @__PURE__ */ defineLimits(
  videoLimitDefinitions,
  { errorClass: VideoError },
);
