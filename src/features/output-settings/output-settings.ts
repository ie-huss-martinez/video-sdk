import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import {
  codePointLength,
  MAX_METADATA_LENGTH,
  snapFrameRate,
  type VideoMetadata,
  type VideoPlan,
  type VideoPlanOutput,
} from "../../core/model/plan.js";
import type { VideoCommand } from "../../core/operations/commands.js";

/** The sample rates the inspector offers, besides the plan's own. */
const SAMPLE_RATES: readonly number[] = [44_100, 48_000];
/** The channel counts it offers, besides the plan's own: mono and stereo. */
const CHANNELS: readonly number[] = [1, 2];

/**
 * A change to the output, as the inspector's fields give it: a size, a frame
 * rate in frames per second, a sample rate or a channel count.
 *
 * @internal
 */
export interface OutputChange {
  readonly width?: number;
  readonly height?: number;
  /** Frames per second, such as 29.97, snapped to an exact rate. */
  readonly framesPerSecond?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
}

/**
 * Why an output can't be set, as the inspector says it, or `undefined`:
 * the file policy's limits, which the session would refuse it for.
 *
 * @internal
 */
export type OutputProblem =
  | { readonly reason: "too-large"; readonly maximum: number }
  | { readonly reason: "rate-too-high"; readonly maximum: number };

/** A size the encoders take: a whole, even number, at least 2. */
const even = (value: number) => {
  const whole = Math.floor(Number.isFinite(value) ? value : 2);
  return Math.max(2, whole - (whole % 2));
};

/**
 * The output after a change: sizes rounded down to even numbers of at least
 * 2, as encoders need, and a frame rate snapped to an exact one, such as
 * 30000/1001 for 29.97 (docs/adr/0003). What isn't given stays.
 *
 * @internal
 */
export function changedOutput(output: VideoPlanOutput, change: OutputChange): VideoPlanOutput {
  return {
    width: change.width === undefined ? output.width : even(change.width),
    height: change.height === undefined ? output.height : even(change.height),
    frameRate:
      change.framesPerSecond === undefined || !(change.framesPerSecond > 0)
        ? output.frameRate
        : snapFrameRate(change.framesPerSecond),
    sampleRate: change.sampleRate ?? output.sampleRate,
    channels: change.channels ?? output.channels,
  };
}

/**
 * What the session would refuse in an output, by its file policy, before
 * the command is built (docs/adr/0004): its pixels over `maxFramePixels`,
 * or its rate over `maxFrameRate`. The sample rates and channel counts the
 * inspector offers are within every default.
 *
 * @internal
 */
export function outputProblem(
  policy: VideoFilePolicy,
  output: VideoPlanOutput,
): OutputProblem | undefined {
  const pixels = policy.limits.maxFramePixels.maximum;
  if (output.width * output.height > pixels) return { reason: "too-large", maximum: pixels };
  const rate = policy.limits.maxFrameRate.maximum;
  if (output.frameRate.num / output.frameRate.den > rate) {
    return { reason: "rate-too-high", maximum: rate };
  }
  return undefined;
}

/**
 * The command that sets the output, or `null` when the change leaves it as
 * it is, so an unchanged field is no undo step.
 *
 * @internal
 */
export function outputCommand(plan: VideoPlan, next: VideoPlanOutput): VideoCommand | null {
  const now = plan.output;
  const same =
    now.width === next.width &&
    now.height === next.height &&
    now.frameRate.num === next.frameRate.num &&
    now.frameRate.den === next.frameRate.den &&
    now.sampleRate === next.sampleRate &&
    now.channels === next.channels;
  return same ? null : { type: "video.setOutput", output: next };
}

/** The choices for a value: the offered ones, and the plan's own if it's another, in order. */
const choices = (offered: readonly number[], current: number) =>
  [...new Set([...offered, current])].sort((a, b) => a - b);

/**
 * The sample rates the inspector offers for an output: 44.1 and 48 kHz, and
 * the output's own when it's another.
 *
 * @internal
 */
export const sampleRateChoices = (output: VideoPlanOutput) =>
  choices(SAMPLE_RATES, output.sampleRate);

/**
 * The channel counts the inspector offers: mono and stereo, and the
 * output's own when it's another.
 *
 * @internal
 */
export const channelChoices = (output: VideoPlanOutput) => choices(CHANNELS, output.channels);

/**
 * Why a metadata value can't be set, or `undefined` (docs/adr/0005): over
 * 1,000 Unicode code points, as the format counts them; or, for the date,
 * anything but a real calendar date as `YYYY-MM-DD`, the only date a
 * container stores. An empty value is always allowed: it writes nothing.
 *
 * @internal
 */
export function metadataProblem(
  field: keyof VideoMetadata,
  value: string,
): "too-long" | "not-a-date" | undefined {
  if (codePointLength(value) > MAX_METADATA_LENGTH) return "too-long";
  if (field === "date" && value !== "") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return "not-a-date";
    const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return "not-a-date";
    }
  }
  return undefined;
}

/**
 * The command that sets a metadata field, or `null` when the value is as it
 * is, or can't be set.
 *
 * @internal
 */
export function metadataCommand(
  plan: VideoPlan,
  field: keyof VideoMetadata,
  value: string,
): VideoCommand | null {
  if (plan.metadata[field] === value || metadataProblem(field, value)) return null;
  return { type: "video.setMetadata", field, value };
}
