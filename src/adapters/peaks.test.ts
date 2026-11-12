import { describe, expect, it } from "vitest";
import { createPeakBuilder, PEAK_BUCKET_DURATION } from "./peaks.js";

describe("the peak builder", () => {
  it("keeps the lowest and highest sample of each bucket, across channels", () => {
    // 50 ms at 1 kHz: five buckets of ten samples.
    const builder = createPeakBuilder(0, 50_000);
    const left = Float32Array.from({ length: 50 }, (_, i) => (i < 10 ? 0.5 : -0.25));
    const right = Float32Array.from({ length: 50 }, (_, i) => (i === 25 ? 0.9 : 0));
    builder.add({ timestamp: 0, sampleRate: 1_000, numberOfFrames: 50, channels: [left, right] });
    const { bucketDuration, min, max } = builder.finish();
    expect(bucketDuration).toBe(PEAK_BUCKET_DURATION);
    expect([...max]).toEqual([0.5, 0, 0.8999999761581421, 0, 0]);
    expect([...min]).toEqual([0, -0.25, -0.25, -0.25, -0.25]);
  });

  it("places chunks by their timestamps, and ignores samples outside the duration", () => {
    const builder = createPeakBuilder(0, 20_000);
    const chunk = (timestamp: number) => ({
      timestamp,
      sampleRate: 1_000,
      numberOfFrames: 10,
      channels: [new Float32Array(10).fill(0.5)],
    });
    builder.add(chunk(10_000));
    builder.add(chunk(-10_000));
    builder.add(chunk(30_000));
    expect([...builder.finish().max]).toEqual([0, 0.5]);
  });

  it("clamps samples over full scale to [-1, 1], and leaves out samples that aren't numbers", () => {
    const builder = createPeakBuilder(0, 20_000);
    const hot = Float32Array.from([1.5, -1.5, Number.NaN, 0.25, 0, 0, 0, 0, 0, 0]);
    const lost = new Float32Array(10).fill(Number.NaN);
    builder.add({ timestamp: 0, sampleRate: 1_000, numberOfFrames: 10, channels: [hot] });
    builder.add({ timestamp: 10_000, sampleRate: 1_000, numberOfFrames: 10, channels: [lost] });
    const { min, max } = builder.finish();
    expect([...max]).toEqual([1, 0]);
    expect([...min]).toEqual([-1, 0]);
  });

  it("counts buckets from the source's start, not from the container's 0", () => {
    // A source whose timestamps start at 1 s: its first sample is in bucket 0.
    const builder = createPeakBuilder(1_000_000, 20_000);
    const chunk = (timestamp: number) => ({
      timestamp,
      sampleRate: 1_000,
      numberOfFrames: 10,
      channels: [new Float32Array(10).fill(0.5)],
    });
    builder.add(chunk(1_000_000));
    builder.add(chunk(990_000));
    expect([...builder.finish().max]).toEqual([0.5, 0]);
  });

  it("always has at least one bucket", () => {
    expect(createPeakBuilder(0, 0).finish().max).toHaveLength(1);
  });
});
