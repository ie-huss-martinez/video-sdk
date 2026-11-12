import type { VideoPeaks } from "../core/model/source.js";

/** The waveform's resolution: one bucket every 10 ms (docs/adr/0002). */
export const PEAK_BUCKET_DURATION = 10_000;

/** The parts of a decoded `AudioData` the peaks need. */
export interface AudioSamples {
  /** Microseconds. */
  readonly timestamp: number;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  /** One array of samples per channel. */
  readonly channels: readonly Float32Array[];
}

/**
 * Builds a source's waveform peaks from its decoded audio, chunk by chunk:
 * for each bucket, the lowest and highest sample across all channels. It
 * holds only the peaks, never the audio.
 *
 * Buckets count from `start`, the source's origin in the container's time,
 * so the waveform lines up with the video (ADR 0003). Samples are clamped to
 * [-1, 1], because decoded audio can go over full scale, and samples that
 * aren't numbers are left out.
 *
 * @internal
 */
export function createPeakBuilder(
  start: number,
  duration: number,
  bucketDuration = PEAK_BUCKET_DURATION,
) {
  const buckets = Math.max(1, Math.ceil(duration / bucketDuration));
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  return {
    add({ timestamp, sampleRate, numberOfFrames, channels }: AudioSamples): void {
      for (let frame = 0; frame < numberOfFrames; frame += 1) {
        const time = timestamp + (frame * 1_000_000) / sampleRate - start;
        const bucket = Math.floor(time / bucketDuration);
        if (bucket < 0 || bucket >= buckets) continue;
        for (const channel of channels) {
          const raw = channel[frame] as number;
          if (Number.isNaN(raw)) continue;
          const sample = Math.max(-1, Math.min(1, raw));
          if (sample < (min[bucket] as number)) min[bucket] = sample;
          if (sample > (max[bucket] as number)) max[bucket] = sample;
        }
      }
    },
    finish(): VideoPeaks {
      return { bucketDuration, min, max };
    },
  };
}
