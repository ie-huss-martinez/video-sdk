import { addRotations, rotateSize, type VideoRotation, type VideoSourceInfo } from "./source.js";
import { type FrameRate, framesIn, frameTime, isFrameRate, isOnGrid, isWhole } from "./time.js";

/**
 * The shape of an audio fade: `linear` changes the gain at a constant rate,
 * and `equalPower` keeps the perceived loudness steadier.
 *
 * @public
 */
export type VideoFadeCurve = "linear" | "equalPower";

/**
 * An audio fade at one end of a clip, in microseconds. `duration: 0` is no
 * fade.
 *
 * @public
 */
export interface VideoFade {
  readonly duration: number;
  readonly curve: VideoFadeCurve;
}

/**
 * How a clip's picture fills the output: `contain` shows all of it,
 * letterboxed; `cover` fills the output and cuts it at the edges.
 *
 * @public
 */
export type VideoFit = "contain" | "cover";

/**
 * A rectangle in whole pixels of the source as it's shown: after the
 * source's own rotation and the clip's.
 *
 * @public
 */
export interface VideoCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A clip's picture: its rotation, added to the source's own, its crop, and
 * how it fills the output (ADR 0003).
 *
 * @public
 */
export interface VideoTransform {
  readonly rotation: VideoRotation;
  /** `null` shows the whole picture. */
  readonly crop: VideoCrop | null;
  readonly fit: VideoFit;
}

/**
 * One piece of a source, played in the plan (ADR 0003).
 *
 * @public
 */
export interface VideoClip {
  /** Stable across edits, so selection and thumbnails follow a clip that moves. */
  readonly key: string;
  /** The id of the source the clip plays. */
  readonly source: string;
  /** The first source microsecond the clip plays, inclusive. */
  readonly start: number;
  /** The source microsecond the clip stops before, exclusive. Always on the output's frame grid. */
  readonly end: number;
  /** The clip's audio volume in decibels. 0 leaves it unchanged. */
  readonly volumeDb: number;
  readonly muted: boolean;
  readonly fadeIn: VideoFade;
  readonly fadeOut: VideoFade;
  readonly transform: VideoTransform;
}

/**
 * What an export produces: its frame size, frame rate and audio layout
 * (ADR 0003).
 *
 * @public
 */
export interface VideoPlanOutput {
  /** Even, as encoders need. */
  readonly width: number;
  readonly height: number;
  readonly frameRate: FrameRate;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * The only metadata an export writes (ADR 0005). Nothing is read from a
 * source into it.
 *
 * @public
 */
export interface VideoMetadata {
  readonly title: string;
  readonly description: string;
  readonly artist: string;
  readonly date: string;
  readonly comment: string;
}

/**
 * The session's document: clips played back to back on one track, over
 * immutable sources, with the output and the metadata (ADR 0003). Every
 * clip covers a whole number of output frames.
 *
 * @public
 */
export interface VideoPlan {
  readonly output: VideoPlanOutput;
  readonly clips: readonly VideoClip[];
  readonly metadata: VideoMetadata;
}

/**
 * The longest metadata value, in UTF-16 code units.
 *
 * @public
 */
export const MAX_METADATA_LENGTH = 1_000;

/**
 * The quietest and loudest volume a clip can have, in decibels.
 *
 * @public
 */
export const VOLUME_RANGE: { readonly min: number; readonly max: number } = Object.freeze({
  min: -96,
  max: 24,
});

/**
 * Metadata with every field empty.
 *
 * @public
 */
export const EMPTY_METADATA: VideoMetadata = Object.freeze({
  title: "",
  description: "",
  artist: "",
  date: "",
  comment: "",
});

/**
 * No fade.
 *
 * @public
 */
export const NO_FADE: VideoFade = Object.freeze({ duration: 0, curve: "linear" });

/**
 * The whole picture, unrotated, letterboxed.
 *
 * @public
 */
export const IDENTITY_TRANSFORM: VideoTransform = Object.freeze({
  rotation: 0,
  crop: null,
  fit: "contain",
});

/**
 * A plan with no clips.
 *
 * @public
 */
export function createPlan(output: VideoPlanOutput): VideoPlan {
  return { output, clips: [], metadata: EMPTY_METADATA };
}

const COMMON_RATES: readonly FrameRate[] = [
  { num: 24_000, den: 1_001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30_000, den: 1_001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60_000, den: 1_001 },
  { num: 60, den: 1 },
];

/**
 * A measured frame rate as an exact one: the nearest common rate within
 * 0.1%, or else the nearest whole number of frames per second, at least 1
 * (ADR 0003).
 *
 * @public
 */
export function snapFrameRate(framesPerSecond: number): FrameRate {
  for (const rate of COMMON_RATES) {
    const exact = rate.num / rate.den;
    if (Math.abs(framesPerSecond - exact) <= exact * 0.001) return rate;
  }
  return { num: Math.max(1, Math.round(framesPerSecond)), den: 1 };
}

/**
 * The output a plan gets from its first source (ADR 0003): its display size
 * after rotation, rounded down to even numbers; its frame rate, snapped; and
 * its audio layout, or 48 kHz stereo when it has no audio.
 *
 * @public
 */
export function outputFromSource(source: VideoSourceInfo): VideoPlanOutput {
  const shown = rotateSize(source.video, source.video.rotation);
  const even = (value: number) => Math.max(2, value - (value % 2));
  return {
    width: even(shown.width),
    height: even(shown.height),
    frameRate: snapFrameRate(source.video.frameRate),
    sampleRate: source.audio?.sampleRate ?? 48_000,
    channels: source.audio?.channels ?? 2,
  };
}

/**
 * How many output frames a clip covers.
 *
 * @public
 */
export function clipFrames(clip: VideoClip, rate: FrameRate): number {
  return framesIn(clip.end - clip.start, rate);
}

/**
 * The plan's length in output frames: the sum of its clips'.
 *
 * @public
 */
export function planFrames(plan: VideoPlan): number {
  let total = 0;
  for (const clip of plan.clips) total += clipFrames(clip, plan.output.frameRate);
  return total;
}

/**
 * Where each clip starts on the timeline, in output frames. It's derived
 * from the clips before it, never stored, so it can't disagree with them
 * (ADR 0003).
 *
 * @public
 */
export function clipOffsets(plan: VideoPlan): readonly number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const clip of plan.clips) {
    offsets.push(at);
    at += clipFrames(clip, plan.output.frameRate);
  }
  return offsets;
}

/**
 * Where an output frame falls: the clip's index, the frame within the clip,
 * and the source time it shows, which is the clip's start plus the frame's
 * time (ADR 0003). The source frame shown is the latest one at or before
 * that time. `undefined` past the end of the plan.
 *
 * @public
 */
export function locateFrame(
  plan: VideoPlan,
  frame: number,
): { readonly index: number; readonly frame: number; readonly sourceTime: number } | undefined {
  if (!isWhole(frame)) return undefined;
  const rate = plan.output.frameRate;
  let at = 0;
  for (const [index, clip] of plan.clips.entries()) {
    const frames = clipFrames(clip, rate);
    if (frame < at + frames) {
      const within = frame - at;
      return { index, frame: within, sourceTime: clip.start + frameTime(within, rate) };
    }
    at += frames;
  }
  return undefined;
}

/**
 * The source range of `frames` output frames starting at `start`: where a
 * clip that starts there and is that long ends.
 *
 * @public
 */
export function clipEnd(start: number, frames: number, rate: FrameRate): number {
  return start + frameTime(frames, rate);
}

function isFade(fade: VideoFade): boolean {
  return isWhole(fade.duration) && (fade.curve === "linear" || fade.curve === "equalPower");
}

/**
 * Why a crop doesn't fit a source as it's shown, or `undefined` if it does:
 * whole pixels, at least 2 × 2, inside the source after its own rotation
 * and the clip's.
 *
 * @internal
 */
export function cropProblem(
  crop: VideoCrop,
  source: VideoSourceInfo,
  rotation: VideoRotation,
): string | undefined {
  const shown = rotateSize(source.video, addRotations(source.video.rotation, rotation));
  if (![crop.x, crop.y, crop.width, crop.height].every(isWhole)) {
    return "A crop must be in whole pixels.";
  }
  if (crop.width < 2 || crop.height < 2) return "A crop must be at least 2 × 2 pixels.";
  if (crop.x + crop.width > shown.width || crop.y + crop.height > shown.height) {
    return "A crop must be inside its source.";
  }
  return undefined;
}

/**
 * Why a clip isn't valid in a plan with this frame rate, over this source,
 * or `undefined` if it is (ADR 0003): a range inside the source on the
 * frame grid, a finite volume in range, fades that fit, and a transform
 * whose crop fits the source.
 *
 * @internal
 */
export function clipProblem(
  clip: VideoClip,
  rate: FrameRate,
  source: VideoSourceInfo | undefined,
): string | undefined {
  if (typeof clip.key !== "string" || clip.key === "") return "A clip needs a key.";
  if (source === undefined) return `Unknown source "${clip.source}".`;
  if (!isWhole(clip.start) || !isWhole(clip.end)) {
    return "A clip's range must be whole microseconds.";
  }
  if (!isOnGrid(clip.start, clip.end, rate)) {
    return "A clip must cover a whole number of output frames, at least one.";
  }
  if (clip.end > source.duration) return "A clip must end within its source.";
  if (
    !Number.isFinite(clip.volumeDb) ||
    clip.volumeDb < VOLUME_RANGE.min ||
    clip.volumeDb > VOLUME_RANGE.max
  ) {
    return `A volume must be between ${VOLUME_RANGE.min} and ${VOLUME_RANGE.max} dB.`;
  }
  if (typeof clip.muted !== "boolean") return "Muted must be true or false.";
  if (!isFade(clip.fadeIn) || !isFade(clip.fadeOut)) {
    return "A fade needs a whole number of microseconds and a known curve.";
  }
  if (clip.fadeIn.duration + clip.fadeOut.duration > clip.end - clip.start) {
    return "A clip's fades must fit within it.";
  }
  const { transform } = clip;
  if (![0, 90, 180, 270].includes(transform.rotation)) {
    return "A rotation must be 0, 90, 180 or 270 degrees.";
  }
  if (transform.fit !== "contain" && transform.fit !== "cover") {
    return "A fit must be contain or cover.";
  }
  return transform.crop === null
    ? undefined
    : cropProblem(transform.crop, source, transform.rotation);
}

/**
 * Why an output isn't valid, or `undefined` if it is: even sizes of at
 * least 2, an exact frame rate, and a whole sample rate and channel count.
 * The file policy's limits are checked by the session, not here.
 *
 * @internal
 */
export function outputProblem(output: VideoPlanOutput): string | undefined {
  const evenSize = (value: number) => isWhole(value) && value >= 2 && value % 2 === 0;
  if (!evenSize(output.width) || !evenSize(output.height)) {
    return "An output's width and height must be even and at least 2.";
  }
  if (!isFrameRate(output.frameRate)) return "An output's frame rate must be a positive fraction.";
  if (!isWhole(output.sampleRate) || output.sampleRate < 1) {
    return "An output's sample rate must be a positive whole number.";
  }
  if (!isWhole(output.channels) || output.channels < 1) {
    return "An output needs at least one audio channel.";
  }
  return undefined;
}
