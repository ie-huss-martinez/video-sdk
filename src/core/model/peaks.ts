import type { VideoPeaks } from "./source.js";

/**
 * Options for {@link peakColumns}: the source's time to draw, in
 * microseconds, and how many columns to draw it in.
 *
 * @public
 */
export interface VideoPeakColumnsOptions {
  /** The first microsecond of the source to draw. */
  readonly from: number;
  /** The microsecond after the last one to draw. */
  readonly to: number;
  /** How many columns, such as one per device pixel. */
  readonly columns: number;
}

/**
 * Each column's lowest and highest sample, from -1 to 1.
 *
 * @public
 */
export interface VideoPeakColumns {
  /** Each column's lowest sample, or 0 when every sample is above the centre. */
  readonly min: Float32Array;
  /** Each column's highest sample, or 0 when every sample is below the centre. */
  readonly max: Float32Array;
}

/**
 * A waveform's columns, drawn from a source's peaks, never from its samples
 * (ADR 0008): for each of `columns` equal parts of the source's time from
 * `from` to `to`, the lowest and highest sample in the peaks' buckets it
 * covers, and the centre line, 0. A column always reads at least the bucket
 * it starts in, so a column narrower than a bucket still shows it. Time past
 * the peaks' end is silent, 0. It's audio-sdk's `peakColumns` for video's
 * single level of buckets, in microseconds.
 *
 * @throws `RangeError` for times that aren't whole microseconds from 0 with
 *   `from` before `to`, or `columns` that isn't a whole number from 1.
 * @public
 */
export function peakColumns(peaks: VideoPeaks, options: VideoPeakColumnsOptions): VideoPeakColumns {
  const { from, to, columns } = options;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new RangeError(
      "A waveform's range must be whole microseconds from 0, with from before to.",
    );
  }
  if (!Number.isSafeInteger(columns) || columns < 1) {
    throw new RangeError("A waveform needs a whole number of columns, from 1.");
  }
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const { bucketDuration } = peaks;
  const buckets = Math.min(peaks.min.length, peaks.max.length);
  const span = to - from;
  for (let column = 0; column < columns; column += 1) {
    const start = from + (span * column) / columns;
    const end = from + (span * (column + 1)) / columns;
    const first = Math.floor(start / bucketDuration);
    const last = Math.min(buckets, Math.max(first + 1, Math.ceil(end / bucketDuration)));
    let low = 0;
    let high = 0;
    for (let bucket = first; bucket < last; bucket += 1) {
      low = Math.min(low, peaks.min[bucket] as number);
      high = Math.max(high, peaks.max[bucket] as number);
    }
    min[column] = low;
    max[column] = high;
  }
  return { min, max };
}
