import { describe, expect, it } from "vitest";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoPlan,
} from "../model/plan.js";
import { channelMatrix } from "./channels.js";
import { mixWindow, type SourceSamples, sourceSpan } from "./mix.js";
import { kernelRadius, resample } from "./resample.js";

const RATE = { num: 30, den: 1 };

function sine(frequency: number, rate: number, length: number, amplitude = 0.5): Float32Array {
  return Float32Array.from(
    { length },
    (_, n) => amplitude * Math.sin((2 * Math.PI * frequency * n) / rate),
  );
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function clip(
  source: string,
  startFrame: number,
  frames: number,
  extra: Partial<VideoClip> = {},
): VideoClip {
  const start = Math.round((startFrame * 1_000_000) / 30);
  return {
    key: `${source}${startFrame}`,
    source,
    start,
    end: clipEnd(start, frames, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
    ...extra,
  };
}

function planOf(channels: number, ...clips: VideoClip[]): VideoPlan {
  return {
    ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels }),
    clips,
  };
}

/** A whole source, as `samplesFor` would give the decoded audio. */
function whole(sampleRate: number, ...channels: Float32Array[]): SourceSamples {
  return { sampleRate, start: 0, channels };
}

describe("mixing channels by Web Audio's speaker rules", () => {
  it("up-mixes and down-mixes mono, stereo, quad and 5.1", () => {
    expect(channelMatrix(1, 2)).toEqual([[1], [1]]);
    expect(channelMatrix(2, 1)).toEqual([[0.5, 0.5]]);
    expect(channelMatrix(1, 6)).toEqual([[0], [0], [1], [0], [0], [0]]);
    expect(channelMatrix(6, 2)).toEqual([
      [1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0],
      [0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    ]);
    expect(channelMatrix(4, 2)).toEqual([
      [0.5, 0, 0.5, 0],
      [0, 0.5, 0, 0.5],
    ]);
  });

  it("maps other layouts discretely", () => {
    expect(channelMatrix(3, 2)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(channelMatrix(2, 3)).toEqual([
      [1, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(channelMatrix(2, 2)).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("the resampler", () => {
  it("copies samples exactly at the same rate and a whole position", () => {
    const input = sine(440, 48_000, 1_000);
    expect(resample(input, 0, 48_000, 48_000, 100, 50)).toEqual(input.slice(100, 150));
    // Outside the input is silence.
    expect(resample(input, 0, 48_000, 48_000, 990, 20).slice(10)).toEqual(new Float32Array(10));
  });

  it.each([
    [48_000, 44_100],
    [44_100, 48_000],
    [22_050, 48_000],
  ])("keeps a 1 kHz tone's shape from %i Hz to %i Hz", (from, to) => {
    const input = sine(1_000, from, from);
    const output = resample(input, 0, from, to, 0, to);
    const expected = sine(1_000, to, to);
    // Away from the edges, where the input runs out.
    let worst = 0;
    for (let n = 2_000; n < to - 2_000; n += 1) {
      worst = Math.max(worst, Math.abs((output[n] as number) - (expected[n] as number)));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it("removes what's above the output's Nyquist when downsampling", () => {
    // 30 kHz can't be represented at 48 kHz: it must not fold back as 18 kHz.
    const input = sine(30_000, 96_000, 96_000);
    const output = resample(input, 0, 96_000, 48_000, 0, 48_000);
    expect(rms(output.slice(2_000, -2_000))).toBeLessThan(0.01);
  });

  it("gives the same samples in pieces as in one pass", () => {
    const input = sine(1_234, 44_100, 44_100);
    const once = resample(input, 0, 44_100, 48_000, 0, 4_800);
    const first = resample(input, 0, 44_100, 48_000, 0, 1_000);
    const rest = resample(input, 0, 44_100, 48_000, (1_000 * 44_100) / 48_000, 3_800);
    expect(Float32Array.from([...first, ...rest])).toEqual(once);
  });

  it("reads within its radius of each position", () => {
    expect(kernelRadius(48_000, 48_000)).toBe(16);
    expect(kernelRadius(96_000, 48_000)).toBe(32);
  });
});

describe("mixing a window of the plan", () => {
  const tone = sine(440, 48_000, 48_000 * 4);

  it("plays a clip's samples at its place on the timeline", () => {
    // Source frames 30–59, so source sample 48,000 onwards, from timeline 0.
    const plan = planOf(1, clip("s", 30, 30));
    const [mono] = mixWindow(plan, 48_000, 0, 1_000, () => whole(48_000, tone));
    expect(mono).toEqual(tone.slice(48_000, 49_000));
  });

  it("applies volume and mute, and is silent for a clip without audio", () => {
    const loud = mixWindow(planOf(1, clip("s", 0, 30, { volumeDb: -6 })), 48_000, 0, 100, () =>
      whole(48_000, tone),
    )[0] as Float32Array;
    expect(loud[50]).toBeCloseTo((tone[50] as number) * 10 ** (-6 / 20), 6);
    const muted = mixWindow(planOf(1, clip("s", 0, 30, { muted: true })), 48_000, 0, 100, () =>
      whole(48_000, tone),
    );
    expect(muted).toEqual([new Float32Array(100)]);
    expect(mixWindow(planOf(2, clip("s", 0, 30)), 48_000, 0, 100, () => null)).toEqual([
      new Float32Array(100),
      new Float32Array(100),
    ]);
  });

  it("fades in from silence", () => {
    const plan = planOf(1, clip("s", 0, 30, { fadeIn: { duration: 100_000, curve: "linear" } }));
    const dc = new Float32Array(48_000).fill(1);
    const [mono] = mixWindow(plan, 48_000, 0, 9_600, () => whole(48_000, dc));
    expect(mono?.[0]).toBe(0);
    expect(mono?.[2_400]).toBeCloseTo(0.5, 6);
    expect(mono?.[4_800]).toBe(1);
  });

  it("switches source at a cut, on the sample", () => {
    const a = new Float32Array(48_000).fill(0.25);
    const b = new Float32Array(48_000).fill(-0.5);
    const plan = planOf(1, clip("a", 0, 15), clip("b", 0, 15));
    const [mono] = mixWindow(plan, 48_000, 23_990, 20, (index) =>
      whole(48_000, index === 0 ? a : b),
    );
    expect(Array.from(mono ?? [])).toEqual([...Array(10).fill(0.25), ...Array(10).fill(-0.5)]);
  });

  it("up-mixes a mono source into a stereo output", () => {
    const [left, right] = mixWindow(planOf(2, clip("s", 0, 30)), 48_000, 0, 100, () =>
      whole(48_000, tone),
    );
    expect(left).toEqual(tone.slice(0, 100));
    expect(right).toEqual(left);
  });

  it("joins windows without a seam, through resampling", () => {
    const source = sine(440, 44_100, 44_100 * 2);
    const plan = planOf(2, clip("s", 7, 40), clip("s", 3, 20));
    const samplesFor = () => whole(44_100, source, source);
    const once = mixWindow(plan, 48_000, 0, 48_000, samplesFor);
    const pieces = [0, 12_000, 24_000, 36_000].map(
      (from) => mixWindow(plan, 48_000, from, 12_000, samplesFor)[0] as Float32Array,
    );
    expect(Float32Array.from(pieces.flatMap((piece) => [...piece]))).toEqual(once[0]);
  });

  it("needs only the source span it names", () => {
    const source = sine(440, 44_100, 44_100 * 2);
    const plan = planOf(1, clip("s", 7, 40));
    const full = mixWindow(plan, 48_000, 6_000, 12_000, () => whole(44_100, source));
    const span = sourceSpan(plan, 0, 48_000, 6_000, 12_000, 44_100);
    if (!span) throw new Error("expected a span");
    const trimmed = mixWindow(plan, 48_000, 6_000, 12_000, () => ({
      sampleRate: 44_100,
      start: span.start,
      channels: [source.slice(span.start, span.end)],
    }));
    expect(trimmed).toEqual(full);
    expect(sourceSpan(plan, 0, 48_000, 70_000, 100, 44_100)).toBeUndefined();
  });
});
