import { VideoError } from "../errors/video-error.js";
import type { VideoPlan, VideoSourceBounds } from "../model/plan.js";
import type { VideoRotation, VideoSourceInfo } from "../model/source.js";
import {
  Invalid,
  isKey,
  isRecord,
  malformed,
  onlyFields,
  readClip,
  readMetadata,
  readOutput,
  reject,
  type VideoCommandRejection,
} from "../operations/read.js";

/**
 * The name of the clip plan's portable format (sdk-core ADR 0045).
 *
 * @public
 */
export const VIDEO_PLAN_FORMAT = "hm-video-plan";

/**
 * The version of {@link VIDEO_PLAN_FORMAT} this release writes, and the
 * latest it reads.
 *
 * @public
 */
export const VIDEO_PLAN_VERSION = 1;

/**
 * A content-addressed reference to binary data, such as a source's file
 * (sdk-core ADR 0045). Documents never inline bytes.
 *
 * @public
 */
export interface VideoAssetReference {
  /** `sha256:` and the lowercase hex SHA-256 of the bytes. */
  readonly asset: string;
  /** The bytes' media type, such as `video/mp4`, in lowercase. */
  readonly mediaType: string;
  /** The size of the bytes. */
  readonly size: number;
}

/**
 * A source, as a plan document records it: what its clips are checked
 * against, its length and its picture's size and rotation, and, once
 * documents travel with their files, its content.
 *
 * @public
 */
export interface VideoPlanDocumentSource {
  /** The source's length in microseconds. */
  readonly duration: number;
  /** The picture's size before its rotation, in pixels. */
  readonly width: number;
  readonly height: number;
  /** How the picture is rotated to be shown, clockwise. */
  readonly rotation: VideoRotation;
  readonly asset?: VideoAssetReference;
}

/**
 * The clip plan as portable JSON: `hm-video-plan` version 1, which
 * `formats/hm-video-plan/v1.schema.json` describes
 * (docs/formats/hm-video-plan.md). Every time is a whole number of
 * microseconds, frame rates are exact fractions, and sources are named by
 * the ids their clips use.
 *
 * @public
 */
export interface VideoPlanDocument extends VideoPlan {
  readonly format: typeof VIDEO_PLAN_FORMAT;
  readonly version: typeof VIDEO_PLAN_VERSION;
  readonly sources: Readonly<Record<string, VideoPlanDocumentSource>>;
}

/**
 * Why a plan document was refused, as a stable token: `details.reason` on
 * the error (sdk-core ADR 0045).
 *
 * - With `UNSUPPORTED_FORMAT`: `unknown-format`, a document of another
 *   format, and `unknown-format-version`, a later version than this release
 *   reads.
 * - With `INVALID_DOCUMENT`: `malformed-document`, a document that isn't
 *   shaped as the schema says; `duplicate-key`, two clips with one key;
 *   `metadata-too-long`, as for commands; and a clip's or the output's own
 *   problems, `VideoClipProblem` and `VideoOutputProblem`, such as
 *   `unknown-source` or `clip-outside-source`.
 *
 * @public
 */
export type VideoDocumentRejection =
  | Exclude<VideoCommandRejection, "malformed-command">
  | "malformed-document"
  | "unknown-format"
  | "unknown-format-version";

const DOCUMENT_FIELDS = ["format", "version", "output", "sources", "clips", "metadata"];
const SOURCE_FIELDS = ["duration", "width", "height", "rotation", "asset"];
const ASSET_FIELDS = ["asset", "mediaType", "size"];
const ROTATIONS: readonly number[] = [0, 90, 180, 270];
/** The patterns the schema uses too, so both accept the same documents. */
const ASSET_ID = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const isCount = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;

function readAsset(value: unknown): VideoAssetReference {
  if (!isRecord<VideoAssetReference>(value)) malformed("an asset is an object");
  onlyFields(value, ASSET_FIELDS, "an asset");
  const { asset, mediaType, size } = value;
  if (typeof asset !== "string" || !ASSET_ID.test(asset)) malformed("an asset id is sha256:<hex>");
  if (typeof mediaType !== "string" || mediaType.length > 255 || !MEDIA_TYPE.test(mediaType)) {
    malformed("a media type is type/subtype, in lowercase");
  }
  if (!isCount(size, 0)) malformed("an asset's size is a whole number of bytes");
  return { asset, mediaType, size };
}

/**
 * The sources by id, in a `Map`: ids such as `__proto__` or `toString` are
 * data like any other (sdk-core ADR 0045).
 */
function readSources(value: unknown): Map<string, VideoPlanDocumentSource> {
  if (!isRecord<Record<string, unknown>>(value)) malformed("sources is an object");
  const sources = new Map<string, VideoPlanDocumentSource>();
  for (const [id, source] of Object.entries(value)) {
    if (!isKey(id)) malformed("a source id is a non-empty string");
    if (!isRecord<VideoPlanDocumentSource>(source)) malformed("a source is an object");
    onlyFields(source, SOURCE_FIELDS, "a source");
    const { duration, width, height, rotation } = source;
    if (!isCount(duration, 1)) malformed("a source's duration is a whole number above 0");
    if (!isCount(width, 1) || !isCount(height, 1)) {
      malformed("a source's width and height are whole numbers above 0");
    }
    if (typeof rotation !== "number" || !ROTATIONS.includes(rotation)) {
      malformed("a source's rotation is 0, 90, 180 or 270");
    }
    const entry: VideoPlanDocumentSource = {
      duration,
      width,
      height,
      rotation: rotation as VideoRotation,
      ...(source.asset === undefined ? {} : { asset: readAsset(source.asset) }),
    };
    sources.set(id, entry);
  }
  return sources;
}

const boundsOf = (source: VideoPlanDocumentSource): VideoSourceBounds => ({
  duration: source.duration,
  video: { width: source.width, height: source.height, rotation: source.rotation },
});

function read(value: unknown): {
  plan: VideoPlan;
  sources: Map<string, VideoPlanDocumentSource>;
} {
  if (!isRecord<VideoPlanDocument>(value)) malformed("a document is an object");
  const { format, version } = value;
  if (typeof format !== "string") malformed("format is text");
  if (format !== VIDEO_PLAN_FORMAT) {
    throw new VideoError("UNSUPPORTED_FORMAT", `This isn't an ${VIDEO_PLAN_FORMAT} document.`, {
      details: { format: VIDEO_PLAN_FORMAT, reason: "unknown-format" },
    });
  }
  if (Number.isSafeInteger(version) && (version as number) > VIDEO_PLAN_VERSION) {
    throw new VideoError(
      "UNSUPPORTED_FORMAT",
      `This ${VIDEO_PLAN_FORMAT} document is a later version than this release reads.`,
      { details: { format: VIDEO_PLAN_FORMAT, reason: "unknown-format-version" } },
    );
  }
  if (version !== VIDEO_PLAN_VERSION) malformed("version is 1");
  onlyFields(value, DOCUMENT_FIELDS, "a document");
  const output = readOutput(value.output);
  const sources = readSources(value.sources);
  if (!Array.isArray(value.clips)) malformed("clips is a list");
  const lookup = (id: string) => {
    const source = sources.get(id);
    return source && boundsOf(source);
  };
  const clips = value.clips.map((clip: unknown) => readClip(clip, output.frameRate, lookup));
  const keys = new Set<string>();
  for (const { key } of clips) {
    if (keys.has(key)) reject("duplicate-key", `two clips have the key ${key}`);
    keys.add(key);
  }
  return { plan: { output, clips, metadata: readMetadata(value.metadata) }, sources };
}

/**
 * Reads a plan document, such as one parsed from JSON, checking it as
 * {@link VideoPlanDocument}'s schema does and more: every clip must lie
 * within a source the document lists, on the output's frame grid, and keys
 * must be unique. Unknown fields are refused, never dropped.
 *
 * @param value - The parsed JSON.
 * @returns The plan, and its sources by id.
 * @throws `VideoError` with `UNSUPPORTED_FORMAT` for another format or a
 *   later version, and `INVALID_DOCUMENT` for anything else that's wrong,
 *   with a {@link VideoDocumentRejection} as `details.reason`.
 * @public
 */
export function readVideoPlanDocument(value: unknown): {
  readonly plan: VideoPlan;
  readonly sources: ReadonlyMap<string, VideoPlanDocumentSource>;
} {
  try {
    return read(value);
  } catch (error) {
    if (!(error instanceof Invalid)) throw error;
    const reason = error.reason === "malformed-command" ? "malformed-document" : error.reason;
    throw new VideoError(
      "INVALID_DOCUMENT",
      `Invalid ${VIDEO_PLAN_FORMAT} document: ${error.message}`,
      {
        details: { format: VIDEO_PLAN_FORMAT, reason },
      },
    );
  }
}

/**
 * What a plan document records of a source the session opened.
 *
 * @public
 */
export function videoPlanDocumentSource(info: VideoSourceInfo): VideoPlanDocumentSource {
  return {
    duration: info.duration,
    width: info.video.width,
    height: info.video.height,
    rotation: info.video.rotation,
  };
}

/**
 * Writes a plan as a {@link VideoPlanDocument}, plain JSON-ready data.
 *
 * @param plan - The plan.
 * @param sources - The sources by id, with at least every source the plan's
 *   clips use. They're written as given.
 * @throws `TypeError` if a clip's source is missing from `sources`.
 * @public
 */
export function toVideoPlanDocument(
  plan: VideoPlan,
  sources: ReadonlyMap<string, VideoPlanDocumentSource>,
): VideoPlanDocument {
  for (const clip of plan.clips) {
    if (!sources.has(clip.source)) {
      throw new TypeError(`The sources don't include ${clip.source}, which clip ${clip.key} uses.`);
    }
  }
  const { output, metadata } = plan;
  return {
    format: VIDEO_PLAN_FORMAT,
    version: VIDEO_PLAN_VERSION,
    output: {
      width: output.width,
      height: output.height,
      frameRate: { num: output.frameRate.num, den: output.frameRate.den },
      sampleRate: output.sampleRate,
      channels: output.channels,
    },
    sources: Object.fromEntries(
      [...sources].map(([id, { duration, width, height, rotation, asset }]) => [
        id,
        asset === undefined
          ? { duration, width, height, rotation }
          : { duration, width, height, rotation, asset: { ...asset } },
      ]),
    ),
    clips: plan.clips.map((clip) => ({
      key: clip.key,
      source: clip.source,
      start: clip.start,
      end: clip.end,
      volumeDb: clip.volumeDb,
      muted: clip.muted,
      fadeIn: { duration: clip.fadeIn.duration, curve: clip.fadeIn.curve },
      fadeOut: { duration: clip.fadeOut.duration, curve: clip.fadeOut.curve },
      transform: {
        rotation: clip.transform.rotation,
        crop: clip.transform.crop === null ? null : { ...clip.transform.crop },
        fit: clip.transform.fit,
      },
    })),
    metadata: {
      title: metadata.title,
      description: metadata.description,
      artist: metadata.artist,
      date: metadata.date,
      comment: metadata.comment,
    },
  };
}
