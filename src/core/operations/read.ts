import {
  clipProblem,
  MAX_METADATA_LENGTH,
  outputProblem,
  PROBLEM_MESSAGES,
  type VideoClip,
  type VideoClipProblem,
  type VideoCrop,
  type VideoFade,
  type VideoFadeCurve,
  type VideoFit,
  type VideoMetadata,
  type VideoOutputProblem,
  type VideoPlanOutput,
  type VideoSourceBounds,
  type VideoTransform,
} from "../model/plan.js";
import type { VideoRotation } from "../model/source.js";
import type { FrameRate } from "../model/time.js";

/**
 * Why the reducer refused a command, as a stable token: `details.reason` on
 * `INVALID_COMMAND`, which hosts and conformance vectors compare instead of
 * the message (sdk-core ADR 0045). Tokens never change meaning once
 * released.
 *
 * - A clip's own problems, {@link VideoClipProblem}, and an output's,
 *   {@link VideoOutputProblem}.
 * - `malformed-command`: it isn't shaped as its type says, such as a field
 *   it doesn't have, a list that isn't one, or a frame that isn't a whole
 *   number.
 * - `unknown-command`: its `type` isn't one of `VideoCommand`'s.
 * - `no-clips`: it needs at least one clip, and names none.
 * - `duplicate-key`: it names a clip twice, or gives two new clips one key.
 * - `key-taken`: a new clip's key is already in the plan.
 * - `unknown-clip`: it names a clip the plan doesn't have.
 * - `not-a-boundary`: clips go where no clip starts or ends.
 * - `empty-range`: a range is shorter than one frame.
 * - `frame-outside-plan`: a timeline frame is past the plan's end.
 * - `not-inside-clip`: a split frame isn't strictly inside its clip.
 * - `new-key-required`: it cuts a clip in two without one key for the new part.
 * - `unexpected-key`: it gives a key for a new part where nothing is cut.
 * - `invalid-index`: restored clips' indexes aren't ascending within the plan.
 * - `invalid-order`: restored clips aren't the plan's clips, in order.
 * - `invalid-edge`: a fade's edge isn't `in` or `out`.
 * - `unknown-metadata-field`: the metadata has no such field.
 * - `metadata-too-long`: a metadata value is over {@link MAX_METADATA_LENGTH}
 *   UTF-16 code units.
 *
 * The session adds `no-plan`, for an edit before any file is in, and the
 * processor `empty-plan`, for an export of no clips.
 *
 * @public
 */
export type VideoCommandRejection =
  | VideoClipProblem
  | VideoOutputProblem
  | "malformed-command"
  | "unknown-command"
  | "no-clips"
  | "duplicate-key"
  | "key-taken"
  | "unknown-clip"
  | "not-a-boundary"
  | "empty-range"
  | "frame-outside-plan"
  | "not-inside-clip"
  | "new-key-required"
  | "unexpected-key"
  | "invalid-index"
  | "invalid-order"
  | "invalid-edge"
  | "unknown-metadata-field"
  | "metadata-too-long"
  | "no-plan"
  | "empty-plan";

/**
 * A refusal with its reason, before the reducer or a document reader turns
 * it into its `VideoError`.
 *
 * @internal
 */
export class Invalid extends Error {
  readonly reason: VideoCommandRejection;

  constructor(reason: VideoCommandRejection, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** @internal */
export function reject(reason: VideoCommandRejection, message: string): never {
  throw new Invalid(reason, message);
}

/** @internal */
export function malformed(message: string): never {
  return reject("malformed-command", message);
}

/** An object whose fields, from data that may have been stored or sent, are unchecked. */
export type Unchecked<T> = { readonly [Key in keyof T]?: unknown };

/** @internal */
export function isRecord<T>(value: unknown): value is Unchecked<T> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Fails unless every field the object has is one of `allowed`. Anything else
 * is refused, never dropped, as the formats' schemas refuse it (sdk-core ADR
 * 0045). A field whose value is `undefined` counts as absent.
 *
 * @internal
 */
export function onlyFields(value: object, allowed: readonly string[], what: string): void {
  for (const [field, content] of Object.entries(value)) {
    if (content !== undefined && !allowed.includes(field)) {
      malformed(`${what} has no field ${field}`);
    }
  }
}

/** A whole number of at least `min`, or a failure. @internal */
export function whole(value: unknown, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    malformed(`${name} must be a whole number of at least ${min}`);
  }
  return value as number;
}

/** A list of clip keys, or a failure. @internal */
export function keyList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(isKey)) {
    malformed(`${name} must be a list of non-empty strings`);
  }
  return [...value];
}

const CLIP_FIELDS = [
  "key",
  "source",
  "start",
  "end",
  "volumeDb",
  "muted",
  "fadeIn",
  "fadeOut",
  "transform",
];
const FADE_FIELDS = ["duration", "curve"];
const TRANSFORM_FIELDS = ["rotation", "crop", "fit"];
const CROP_FIELDS = ["x", "y", "width", "height"];
const OUTPUT_FIELDS = ["width", "height", "frameRate", "sampleRate", "channels"];
const RATE_FIELDS = ["num", "den"];
const METADATA_FIELDS: readonly (keyof VideoMetadata)[] = [
  "title",
  "description",
  "artist",
  "date",
  "comment",
];

/** A fade, checked for its shape; its values are the clip's to check. @internal */
export function readFade(value: unknown, name: string): VideoFade {
  if (!isRecord<VideoFade>(value)) malformed(`${name} isn't a fade`);
  onlyFields(value, FADE_FIELDS, name);
  return { duration: value.duration as number, curve: value.curve as VideoFadeCurve };
}

/** A transform, checked for its shape; its values are the clip's to check. @internal */
export function readTransform(value: unknown): VideoTransform {
  if (!isRecord<VideoTransform>(value)) malformed("a transform is an object");
  onlyFields(value, TRANSFORM_FIELDS, "a transform");
  let crop: VideoCrop | null = null;
  if (value.crop !== null) {
    if (!isRecord<VideoCrop>(value.crop)) malformed("a crop is an object or null");
    onlyFields(value.crop, CROP_FIELDS, "a crop");
    const { x, y, width, height } = value.crop;
    crop = { x, y, width, height } as VideoCrop;
  }
  return { rotation: value.rotation as VideoRotation, crop, fit: value.fit as VideoFit };
}

/**
 * A clean copy of a clip, with only its own fields, checked within its
 * source at this frame rate. `sources` gives a source's bounds, or
 * `undefined` for an id that isn't known.
 *
 * @internal
 */
export function readClip(
  value: unknown,
  rate: FrameRate,
  sources: (id: string) => VideoSourceBounds | undefined,
): VideoClip {
  if (!isRecord<VideoClip>(value)) malformed("a clip is an object");
  onlyFields(value, CLIP_FIELDS, "a clip");
  if (!isKey(value.key)) reject("missing-key", PROBLEM_MESSAGES["missing-key"]);
  if (!isKey(value.source)) malformed("a clip's source is a non-empty string");
  const clip: VideoClip = {
    key: value.key,
    source: value.source,
    start: value.start as number,
    end: value.end as number,
    volumeDb: value.volumeDb as number,
    muted: value.muted as boolean,
    fadeIn: readFade(value.fadeIn, "fadeIn"),
    fadeOut: readFade(value.fadeOut, "fadeOut"),
    transform: readTransform(value.transform),
  };
  checkClip(clip, rate, sources);
  return clip;
}

/** Fails with the clip's own problem, if it has one. @internal */
export function checkClip(
  clip: VideoClip,
  rate: FrameRate,
  sources: (id: string) => VideoSourceBounds | undefined,
): void {
  const problem = clipProblem(clip, rate, sources(clip.source));
  if (problem !== undefined) reject(problem, `Clip "${clip.key}": ${PROBLEM_MESSAGES[problem]}`);
}

/** An output, checked. @internal */
export function readOutput(value: unknown): VideoPlanOutput {
  if (!isRecord<VideoPlanOutput>(value)) malformed("an output is an object");
  onlyFields(value, OUTPUT_FIELDS, "an output");
  if (!isRecord<FrameRate>(value.frameRate)) malformed("a frame rate is an object");
  onlyFields(value.frameRate, RATE_FIELDS, "a frame rate");
  const output = {
    width: value.width,
    height: value.height,
    frameRate: { num: value.frameRate.num, den: value.frameRate.den },
    sampleRate: value.sampleRate,
    channels: value.channels,
  } as VideoPlanOutput;
  const problem = outputProblem(output);
  if (problem !== undefined) reject(problem, PROBLEM_MESSAGES[problem]);
  return output;
}

/** Whether a metadata field exists. @internal */
export function isMetadataField(value: unknown): value is keyof VideoMetadata {
  return typeof value === "string" && (METADATA_FIELDS as readonly string[]).includes(value);
}

/** A metadata value, checked. @internal */
export function metadataValue(value: unknown, field: string): string {
  if (typeof value !== "string") malformed(`metadata.${field} is text`);
  if (value.length > MAX_METADATA_LENGTH) {
    reject("metadata-too-long", `metadata.${field} is over ${MAX_METADATA_LENGTH} characters`);
  }
  return value;
}

/** Every metadata field, checked, with nothing else. @internal */
export function readMetadata(value: unknown): VideoMetadata {
  if (!isRecord<VideoMetadata>(value)) malformed("metadata is an object");
  onlyFields(value, METADATA_FIELDS, "metadata");
  return Object.fromEntries(
    METADATA_FIELDS.map((field) => [field, metadataValue(value[field], field)]),
  ) as unknown as VideoMetadata;
}
