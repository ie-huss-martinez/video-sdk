import { gainAt } from "../model/envelope.js";
import type { VideoPlan } from "../model/plan.js";
import { clipStarts } from "../playback/timeline.js";
import { channelMatrix } from "./channels.js";
import { kernelRadius, resample } from "./resample.js";

/**
 * A clip's source audio around a window: planar channels at the source's
 * sample rate, where `channels[c][0]` is source sample `start`, counted from
 * the probe's `start` (docs/adr/0003).
 *
 * @internal
 */
export interface SourceSamples {
  readonly sampleRate: number;
  readonly start: number;
  readonly channels: readonly Float32Array[];
}

/**
 * What clamping did to a mix (docs/adr/0008), counted across the windows
 * that share it, as audio-sdk's export counts it: the largest absolute
 * sample before clamping, and how many sample frames had a sample over full
 * scale.
 *
 * @internal
 */
export interface MixMeter {
  peak: number;
  clippedFrames: number;
}

/** Where each clip starts on the timeline, in samples at `rate`, and where the plan ends. */
export function clipSampleStarts(plan: VideoPlan, rate: number): readonly number[] {
  return clipStarts(plan).map((time) => Math.round((time * rate) / 1_000_000));
}

/**
 * The source samples a window needs from one clip: the samples the window
 * plays, and the resampler's reach on each side, clamped at 0. `undefined`
 * when the window doesn't overlap the clip.
 *
 * @param from - The window's first sample on the timeline, at `rate`.
 * @param count - The window's length, in samples at `rate`.
 * @param sourceRate - The clip's source sample rate.
 * @internal
 */
export function sourceSpan(
  plan: VideoPlan,
  index: number,
  rate: number,
  from: number,
  count: number,
  sourceRate: number,
): { readonly start: number; readonly end: number } | undefined {
  const starts = clipSampleStarts(plan, rate);
  const clip = plan.clips[index];
  const begin = Math.max(from, starts[index] as number);
  const end = Math.min(from + count, starts[index + 1] as number);
  if (!clip || begin >= end) return undefined;
  const step = sourceRate / rate;
  const origin = (clip.start * sourceRate) / 1_000_000 - (starts[index] as number) * step;
  const radius = kernelRadius(sourceRate, rate);
  return {
    start: Math.max(0, Math.floor(origin + begin * step) - radius),
    end: Math.ceil(origin + (end - 1) * step) + radius + 1,
  };
}

/**
 * Mixes one window of the plan's audio (docs/adr/0005): `count` samples at
 * `rate` from timeline sample `from`, in the output's channels. Each clip's
 * source is resampled to `rate`, mixed to the output's channels by Web
 * Audio's speaker rules, and scaled by `gainAt` for its volume, mute and
 * fades. A clip without audio, where `samplesFor` returns `null`, is silent.
 * The same plan and window always give the same samples, and windows join
 * without a seam, so playback and export can make them separately.
 *
 * The mix is clamped to full scale, −1 to 1, and a sample that isn't a
 * finite number is silence, so one bad sample from a decoder can't spoil
 * a window (docs/adr/0008). Nothing limits or normalises it. A `meter`, when
 * given, adds what clamping did, measured before it.
 *
 * @internal
 */
export function mixWindow(
  plan: VideoPlan,
  rate: number,
  from: number,
  count: number,
  samplesFor: (index: number) => SourceSamples | null,
  meter?: MixMeter,
): Float32Array[] {
  const outputs = plan.output.channels;
  const mixed = Array.from({ length: outputs }, () => new Float32Array(count));
  const starts = clipSampleStarts(plan, rate);
  for (const [index, clip] of plan.clips.entries()) {
    const clipStart = starts[index] as number;
    const begin = Math.max(from, clipStart);
    const end = Math.min(from + count, starts[index + 1] as number);
    if (begin >= end) continue;
    const source = samplesFor(index);
    if (!source || clip.muted) continue;
    const step = source.sampleRate / rate;
    const first = (clip.start * source.sampleRate) / 1_000_000 + (begin - clipStart) * step;
    const resampled = source.channels.map((channel) =>
      resample(channel, source.start, source.sampleRate, rate, first, end - begin),
    );
    const matrix = channelMatrix(resampled.length, outputs);
    for (let k = 0; k < end - begin; k += 1) {
      const gain = gainAt(clip, begin - clipStart + k, rate);
      if (gain === 0) continue;
      for (let output = 0; output < outputs; output += 1) {
        const weights = matrix[output] as readonly number[];
        let sum = 0;
        for (let input = 0; input < resampled.length; input += 1) {
          const weight = weights[input] as number;
          if (weight !== 0) sum += weight * ((resampled[input] as Float32Array)[k] as number);
        }
        (mixed[output] as Float32Array)[begin - from + k] = sum * gain;
      }
    }
  }
  clamp(mixed, count, meter);
  return mixed;
}

/** Clamps a mix to full scale in place, silences what isn't finite, and meters it. */
function clamp(mixed: readonly Float32Array[], count: number, meter: MixMeter | undefined): void {
  let peak = 0;
  let clippedFrames = 0;
  for (let k = 0; k < count; k += 1) {
    let clipped = false;
    for (const channel of mixed) {
      const sample = channel[k] as number;
      if (!Number.isFinite(sample)) {
        channel[k] = 0;
        continue;
      }
      const size = Math.abs(sample);
      if (size > peak) peak = size;
      if (size > 1) {
        clipped = true;
        channel[k] = sample > 0 ? 1 : -1;
      }
    }
    if (clipped) clippedFrames += 1;
  }
  if (meter) {
    meter.peak = Math.max(meter.peak, peak);
    meter.clippedFrames += clippedFrames;
  }
}
