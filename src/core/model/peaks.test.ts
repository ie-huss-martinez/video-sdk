import { describe, expect, it } from "vitest";
import { peakColumns } from "./peaks.js";
import type { VideoPeaks } from "./source.js";

/** Peaks of 10 ms buckets, each bucket's sample range as given. */
const peaksOf = (...buckets: readonly (readonly [number, number])[]): VideoPeaks => ({
  bucketDuration: 10_000,
  min: Float32Array.from(buckets.map(([low]) => low)),
  max: Float32Array.from(buckets.map(([, high]) => high)),
});

const rounded = (values: Float32Array) => [...values].map((value) => Math.round(value * 100) / 100);

describe("a waveform's columns", () => {
  const peaks = peaksOf([-0.1, 0.2], [-0.5, 0.4], [-0.3, 0.9], [-0.2, 0.1]);

  it("takes each column's lowest and highest sample from the buckets it covers", () => {
    // Two columns of 20 ms: buckets 0 and 1, then 2 and 3.
    const { min, max } = peakColumns(peaks, { from: 0, to: 40_000, columns: 2 });
    expect(rounded(min)).toEqual([-0.5, -0.3]);
    expect(rounded(max)).toEqual([0.4, 0.9]);
  });

  it("reads the bucket it starts in for a column narrower than a bucket", () => {
    // Four columns of 2.5 ms, all inside bucket 2.
    const { min, max } = peakColumns(peaks, { from: 20_000, to: 30_000, columns: 4 });
    expect(rounded(min)).toEqual([-0.3, -0.3, -0.3, -0.3]);
    expect(rounded(max)).toEqual([0.9, 0.9, 0.9, 0.9]);
  });

  it("includes the centre line, and draws time past the peaks' end as silence", () => {
    const quiet = peaksOf([0.1, 0.3]);
    const { min, max } = peakColumns(quiet, { from: 0, to: 20_000, columns: 2 });
    expect(rounded(min)).toEqual([0, 0]);
    expect(rounded(max)).toEqual([0.3, 0]);
  });

  it("refuses a range or a column count that isn't whole, or is empty", () => {
    for (const options of [
      { from: -1, to: 10, columns: 1 },
      { from: 10, to: 10, columns: 1 },
      { from: 0.5, to: 10, columns: 1 },
      { from: 0, to: 10, columns: 0 },
      { from: 0, to: 10, columns: 1.5 },
    ]) {
      expect(() => peakColumns(peaks, options), JSON.stringify(options)).toThrow(RangeError);
    }
  });
});
