import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isVideoError } from "../errors/video-error.js";
import { videoLimits } from "../errors/video-limits.js";
import { clipStarts } from "../playback/timeline.js";
import { dbToGain, gainAt } from "./envelope.js";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  createPlan,
  IDENTITY_TRANSFORM,
  locateFrame,
  NO_FADE,
  outputFromSource,
  planFrames,
  snapFrameRate,
  type VideoClip,
  type VideoPlan,
} from "./plan.js";
import { checkProbe, decodingBound } from "./probe-limits.js";
import { addRotations, rotateSize, sourceInfo, type VideoProbe } from "./source.js";
import {
  framesIn,
  frameTime,
  isOnGrid,
  microsecondsToSeconds,
  secondsToMicroseconds,
} from "./time.js";

const NTSC = { num: 30_000, den: 1_001 };

function probe(overrides: Partial<VideoProbe> = {}): VideoProbe {
  return {
    container: "mp4",
    start: 0,
    duration: 10_000_000,
    tracks: 2,
    indexSize: 50_000,
    peakBitrate: 8_000_000,
    maxPacketSize: 200_000,
    video: {
      codec: "avc1.64001f",
      codedWidth: 1920,
      codedHeight: 1088,
      displayWidth: 1920,
      displayHeight: 1080,
      rotation: 0,
      frameRate: 29.97,
      packets: 300,
    },
    audio: { codec: "mp4a.40.2", sampleRate: 48_000, channels: 2 },
    ...overrides,
  };
}

function clip(key: string, frames: number, overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    key,
    source: "a",
    start: 0,
    end: clipEnd(0, frames, NTSC),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
    ...overrides,
  };
}

describe("time on the frame grid", () => {
  it("times frames exactly for whole rates, and to the microsecond for 30000/1001", () => {
    expect(frameTime(25, { num: 25, den: 1 })).toBe(1_000_000);
    expect(frameTime(1, NTSC)).toBe(33_367);
    expect(frameTime(30_000, NTSC)).toBe(1_001_000_000);
    expect(framesIn(1_001_000_000, NTSC)).toBe(30_000);
  });

  it("accepts a range within a microsecond of the grid, and nothing shorter than a frame", () => {
    expect(isOnGrid(0, frameTime(10, NTSC), NTSC)).toBe(true);
    expect(isOnGrid(5, 5 + frameTime(10, NTSC) + 1, NTSC)).toBe(true);
    expect(isOnGrid(5, 5 + frameTime(10, NTSC) + 2, NTSC)).toBe(false);
    expect(isOnGrid(0, 10_000, NTSC)).toBe(false);
  });

  it("converts seconds to whole microseconds and back", () => {
    expect(secondsToMicroseconds(1.5)).toBe(1_500_000);
    expect(secondsToMicroseconds(1 / 3)).toBe(333_333);
    expect(microsecondsToSeconds(2_500_000)).toBe(2.5);
  });
});

describe("sources and the output", () => {
  it("turns sizes and adds rotations", () => {
    expect(rotateSize({ width: 1920, height: 1080 }, 90)).toEqual({ width: 1080, height: 1920 });
    expect(rotateSize({ width: 1920, height: 1080 }, 180)).toEqual({ width: 1920, height: 1080 });
    expect(addRotations(270, 180)).toBe(90);
  });

  it("snaps measured rates to common ones within 0.1%, and rounds the rest", () => {
    expect(snapFrameRate(29.97)).toEqual(NTSC);
    expect(snapFrameRate(30.01)).toEqual({ num: 30, den: 1 });
    expect(snapFrameRate(59.94)).toEqual({ num: 60_000, den: 1_001 });
    expect(snapFrameRate(15.2)).toEqual({ num: 15, den: 1 });
    expect(snapFrameRate(0.2)).toEqual({ num: 1, den: 1 });
  });

  it("takes the output from the first source: rotated, even, snapped, with its audio", () => {
    const info = sourceInfo(
      "a",
      probe({ video: { ...probe().video, displayWidth: 1279, displayHeight: 721, rotation: 90 } }),
    );
    expect(outputFromSource(info)).toEqual({
      width: 720,
      height: 1278,
      frameRate: NTSC,
      sampleRate: 48_000,
      channels: 2,
    });
    expect(outputFromSource(sourceInfo("b", probe({ audio: null })))).toMatchObject({
      sampleRate: 48_000,
      channels: 2,
    });
  });
});

describe("the plan's timeline", () => {
  const plan = {
    ...createPlan(outputFromSource(sourceInfo("a", probe()))),
    clips: [clip("x", 10), clip("y", 20, { start: 1_000_000, end: clipEnd(1_000_000, 20, NTSC) })],
  };

  it("derives offsets and the length in frames from the clips", () => {
    expect(clipOffsets(plan)).toEqual([0, 10]);
    expect(planFrames(plan)).toBe(30);
  });

  it("locates each output frame in its clip and source", () => {
    expect(locateFrame(plan, 0)).toEqual({ index: 0, frame: 0, sourceTime: 0 });
    expect(locateFrame(plan, 12)).toEqual({
      index: 1,
      frame: 2,
      sourceTime: 1_000_000 + frameTime(2, NTSC),
    });
    expect(locateFrame(plan, 30)).toBeUndefined();
    expect(locateFrame(plan, -1)).toBeUndefined();
  });
});

describe("the timeline helpers from sdk-core (ADR 0042)", () => {
  // The implementations before sdk-core's helpers replaced them, kept here to
  // show that nothing changed.
  const before = {
    clipOffsets(plan: VideoPlan): number[] {
      const offsets: number[] = [];
      let at = 0;
      for (const each of plan.clips) {
        offsets.push(at);
        at += clipFrames(each, plan.output.frameRate);
      }
      return offsets;
    },
    locateFrame(plan: VideoPlan, frame: number) {
      if (!Number.isSafeInteger(frame) || frame < 0) return undefined;
      const rate = plan.output.frameRate;
      let at = 0;
      for (const [index, each] of plan.clips.entries()) {
        const frames = clipFrames(each, rate);
        if (frame < at + frames) {
          const within = frame - at;
          return { index, frame: within, sourceTime: each.start + frameTime(within, rate) };
        }
        at += frames;
      }
      return undefined;
    },
    clipStarts(plan: VideoPlan): number[] {
      const starts: number[] = [];
      let frames = 0;
      for (const each of plan.clips) {
        starts.push(frameTime(frames, plan.output.frameRate));
        frames += clipFrames(each, plan.output.frameRate);
      }
      starts.push(frameTime(frames, plan.output.frameRate));
      return starts;
    },
  };

  const rates = fc.constantFrom(
    NTSC,
    { num: 24, den: 1 },
    { num: 25, den: 1 },
    { num: 60_000, den: 1_001 },
  );
  const plans = fc
    .tuple(
      rates,
      fc.array(fc.tuple(fc.integer({ min: 1, max: 600 }), fc.nat(10_000_000)), { maxLength: 12 }),
    )
    .map(([rate, lengths]) => ({
      ...createPlan({ ...outputFromSource(sourceInfo("a", probe())), frameRate: rate }),
      clips: lengths.map(([frames, start], index) =>
        clip(`c${index}`, frames, { start, end: clipEnd(start, frames, rate) }),
      ),
    }));

  it("gives the same offsets, locations and clip starts as before, for any plan", () => {
    fc.assert(
      fc.property(plans, (plan) => {
        expect(clipOffsets(plan)).toEqual(before.clipOffsets(plan));
        expect(clipStarts(plan)).toEqual(before.clipStarts(plan));
        const total = planFrames(plan);
        for (const frame of [
          -1,
          0.5,
          total,
          total + 1,
          ...Array.from({ length: total }, (_, i) => i),
        ]) {
          expect(locateFrame(plan, frame)).toEqual(before.locateFrame(plan, frame));
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("the audio envelope", () => {
  const RATE = 1_000;
  const second = clip("x", 30, {
    end: 1_000_000,
    fadeIn: { duration: 100_000, curve: "linear" },
    fadeOut: { duration: 100_000, curve: "equalPower" },
  });

  it("starts a fade in at silence and ends a fade out at silence", () => {
    expect(gainAt(second, 0, RATE)).toBe(0);
    expect(gainAt(second, 50, RATE)).toBeCloseTo(0.5);
    expect(gainAt(second, 500, RATE)).toBe(1);
    expect(gainAt(second, 999, RATE)).toBe(0);
    expect(gainAt(second, 949, RATE)).toBeCloseTo(Math.sin(((50 / 100) * Math.PI) / 2));
  });

  it("applies the volume, and silences a muted clip", () => {
    expect(gainAt({ ...second, volumeDb: -6 }, 500, RATE)).toBeCloseTo(dbToGain(-6));
    expect(gainAt({ ...second, muted: true }, 500, RATE)).toBe(0);
  });
});

describe("checking a probe against the limits", () => {
  const policy = videoLimits.resolve();

  it("bounds what one file's decoding holds at once, with the decoders' padding: about 763 MB at 4K", () => {
    const fourK = probe({ video: { ...probe().video, codedWidth: 3840, codedHeight: 2160 } });
    const padded = 21 * (3840 + 128) * (2160 + 128) * 4;
    expect(decodingBound(fourK)).toBe(padded + 12_000 * 2 * 4);
    expect(decodingBound({ ...fourK, audio: null })).toBe(padded);
    expect(Math.round(padded / 1e6)).toBe(763);
    expect(checkProbe(policy, fourK)).toEqual(["maxFramePixels", "maxDecodedSize"]);
  });

  it("passes an ordinary 1080p file with no warnings", () => {
    expect(checkProbe(policy, probe())).toEqual([]);
  });

  it.each([
    [{ indexSize: 64_000_001 }, "INDEX_TOO_LARGE"],
    [{ tracks: 17 }, "TOO_MANY_TRACKS"],
    [{ video: { ...probe().video, codedWidth: 16_384, codedHeight: 16_384 } }, "FRAME_TOO_LARGE"],
    [{ video: { ...probe().video, frameRate: 240 } }, "FRAME_RATE_TOO_HIGH"],
    [{ duration: 3 * 60 * 60 * 1_000_000 + 1 }, "DURATION_TOO_LONG"],
    [{ peakBitrate: 200_000_001 }, "BITRATE_TOO_HIGH"],
    [{ maxPacketSize: 32_000_001 }, "PACKET_TOO_LARGE"],
    [{ audio: { codec: "opus", sampleRate: 48_000, channels: 12 } }, "TOO_MANY_CHANNELS"],
    [{ audio: { codec: "flac", sampleRate: 384_000, channels: 2 } }, "SAMPLE_RATE_TOO_HIGH"],
  ] as const)("refuses %o with its own code", (overrides, code) => {
    let error: unknown;
    try {
      checkProbe(policy, probe(overrides as Partial<VideoProbe>));
    } catch (caught) {
      error = caught;
    }
    expect(isVideoError(error, code)).toBe(true);
  });

  it("counts a duration a microsecond over the limit as over it", () => {
    const limit = 3 * 60 * 60 * 1_000_000;
    expect(() => checkProbe(policy, probe({ duration: limit }))).not.toThrow();
    expect(() => checkProbe(policy, probe({ duration: limit + 1 }))).toThrow();
  });
});
