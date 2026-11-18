import type { VideoClip, VideoCrop, VideoFit, VideoPlan } from "../../core/model/plan.js";
import {
  addRotations,
  rotateSize,
  type VideoRotation,
  type VideoSourceInfo,
} from "../../core/model/source.js";
import type { VideoCommand } from "../../core/operations/commands.js";

/** A width and a height, in whole pixels. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/** The smallest crop the model takes, in pixels each way (docs/adr/0003). */
const MIN_CROP = 2;

/**
 * The picture of the selected clips, as the inspector shows it
 * (docs/adr/0007): one value where the clips agree, and `null` where they
 * differ.
 *
 * @internal
 */
export interface ClipPictureState {
  /** The selected clips that are in the plan, in plan order. */
  readonly keys: readonly string[];
  /** The first of them, or `null` when none is selected. */
  readonly lead: VideoClip | null;
  /** The clips' own rotation, added to their sources', or `null` when they differ. */
  readonly rotation: VideoRotation | null;
  readonly fit: VideoFit | null;
  /**
   * What a crop is measured in, when exactly one clip is selected: its
   * picture as it's shown, after its source's rotation and its own. `null`
   * with several clips, whose pictures may differ in size, or when the
   * clip's source isn't open.
   */
  readonly frame: Size | null;
}

/** The value every item has, or `null` when they differ or there are none. */
function shared<T>(values: readonly T[]): T | null {
  const [first] = values;
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

/** A clip's picture as it's shown: its source's size, turned by the source's rotation and the clip's. */
function shownSize(source: VideoSourceInfo, rotation: VideoRotation): Size {
  return rotateSize(source.video, addRotations(source.video.rotation, rotation));
}

const sourceOf = (sources: readonly VideoSourceInfo[], clip: VideoClip) =>
  sources.find((source) => source.id === clip.source);

/**
 * Reads the selected clips' picture from the plan (docs/adr/0007).
 *
 * @param selected - The selected clips' keys. Keys the plan doesn't have are left out.
 * @internal
 */
export function clipPictureState(
  plan: VideoPlan | null,
  sources: readonly VideoSourceInfo[],
  selected: readonly string[],
): ClipPictureState {
  const chosen = new Set(selected);
  const clips = plan?.clips.filter((clip) => chosen.has(clip.key)) ?? [];
  const [only] = clips;
  const source = only && clips.length === 1 ? sourceOf(sources, only) : undefined;
  return {
    keys: clips.map((clip) => clip.key),
    lead: only ?? null,
    rotation: shared(clips.map((clip) => clip.transform.rotation)),
    fit: shared(clips.map((clip) => clip.transform.fit)),
    frame: only && source ? shownSize(source, only.transform.rotation) : null,
  };
}

/**
 * A crop turned with its picture by a quarter turn, so it frames the same
 * part of it.
 *
 * @param frame - The picture's size before the turn.
 * @param turn - 90 for clockwise, 270 for anticlockwise.
 */
function turnCrop(crop: VideoCrop, frame: Size, turn: 90 | 270): VideoCrop {
  return turn === 90
    ? {
        x: frame.height - (crop.y + crop.height),
        y: crop.x,
        width: crop.height,
        height: crop.width,
      }
    : { x: crop.y, y: frame.width - (crop.x + crop.width), width: crop.height, height: crop.width };
}

/**
 * The commands that turn the selected clips a quarter turn, as one undo
 * step. Each clip turns from its own rotation, and its crop turns with it,
 * so it frames the same part of the picture: the reducer refuses a crop
 * that the turned picture doesn't hold (docs/adr/0003).
 *
 * @param turn - 90 for clockwise, 270 for anticlockwise.
 * @internal
 */
export function rotateCommands(
  plan: VideoPlan,
  sources: readonly VideoSourceInfo[],
  keys: readonly string[],
  turn: 90 | 270,
): VideoCommand[] {
  const chosen = new Set(keys);
  return plan.clips
    .filter((clip) => chosen.has(clip.key))
    .map((clip) => {
      const source = sourceOf(sources, clip);
      const { crop, rotation } = clip.transform;
      return {
        type: "video.setTransform",
        keys: [clip.key],
        transform: {
          ...clip.transform,
          rotation: addRotations(rotation, turn),
          // Without its source there's no size to turn the crop in.
          crop: crop && source ? turnCrop(crop, shownSize(source, rotation), turn) : null,
        },
      } satisfies VideoCommand;
    });
}

/**
 * The commands that set how the selected clips fill the output, as one undo
 * step. Each clip keeps its own rotation and crop.
 *
 * @internal
 */
export function fitCommands(
  plan: VideoPlan,
  keys: readonly string[],
  fit: VideoFit,
): VideoCommand[] {
  const chosen = new Set(keys);
  return plan.clips
    .filter((clip) => chosen.has(clip.key))
    .map(
      (clip) =>
        ({
          type: "video.setTransform",
          keys: [clip.key],
          transform: { ...clip.transform, fit },
        }) satisfies VideoCommand,
    );
}

/**
 * A crop kept inside a picture, in whole pixels and at least
 * {@link MIN_CROP} each way: its corner first, then its size in what's left.
 *
 * @internal
 */
export function clampCrop(crop: VideoCrop, frame: Size): VideoCrop {
  const within = (value: number, least: number, most: number) =>
    Math.min(Math.max(Math.round(Number.isFinite(value) ? value : least), least), most);
  const x = within(crop.x, 0, frame.width - MIN_CROP);
  const y = within(crop.y, 0, frame.height - MIN_CROP);
  return {
    x,
    y,
    width: within(crop.width, MIN_CROP, frame.width - x),
    height: within(crop.height, MIN_CROP, frame.height - y),
  };
}

/**
 * The command that crops one clip, or `null` for one that removes its crop.
 * The crop is kept inside the clip's picture, so the reducer accepts it; a
 * crop of the whole picture is no crop.
 *
 * @param frame - The clip's picture as it's shown, from {@link ClipPictureState.frame}.
 * @param change - The crop's new values, over its present ones or the whole picture.
 * @internal
 */
export function cropCommand(
  clip: VideoClip,
  frame: Size,
  change: Partial<VideoCrop> | null,
): VideoCommand {
  const whole = { x: 0, y: 0, width: frame.width, height: frame.height };
  const next = change ? clampCrop({ ...(clip.transform.crop ?? whole), ...change }, frame) : whole;
  const all =
    next.x === 0 && next.y === 0 && next.width === frame.width && next.height === frame.height;
  return {
    type: "video.setTransform",
    keys: [clip.key],
    transform: { ...clip.transform, crop: all ? null : next },
  };
}
