import { describe, expect, it } from "vitest";
import { clipEnd, createPlan, IDENTITY_TRANSFORM, NO_FADE, type VideoClip } from "../model/plan.js";
import { clipAt, clipStarts, frameAt, mediaTimeAt, stepTarget } from "./timeline.js";

const NTSC = { num: 30_000, den: 1_001 };

function clip(frames: number): VideoClip {
  return {
    key: `k${frames}`,
    source: "s",
    start: 0,
    end: clipEnd(0, frames, NTSC),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

const plan = {
  ...createPlan({ width: 64, height: 36, frameRate: NTSC, sampleRate: 48_000, channels: 2 }),
  clips: [clip(10), clip(20)],
};

describe("playback's timeline", () => {
  it("reads media time from an anchor", () => {
    expect(mediaTimeAt({ media: 500_000, at: 1_000 }, 1_250)).toBe(750_000);
  });

  it("knows where each clip starts and the plan ends, and which clip plays when", () => {
    const starts = clipStarts(plan);
    expect(starts).toEqual([0, 333_667, 1_001_000]);
    expect(clipAt(starts, 0)).toBe(0);
    expect(clipAt(starts, 333_666)).toBe(0);
    expect(clipAt(starts, 333_667)).toBe(1);
    expect(clipAt(starts, 5_000_000)).toBe(1);
  });

  it("maps a time to the frame shown, exactly at frame boundaries", () => {
    for (let frame = 0; frame < 30; frame += 1) {
      const start = Math.round((frame * 1_001_000_000) / 30_000);
      expect(frameAt(plan, start)).toBe(frame);
      if (start > 0) expect(frameAt(plan, start - 1)).toBe(frame - 1);
    }
    expect(frameAt(plan, -5)).toBe(0);
    expect(frameAt(plan, 99_000_000)).toBe(30);
  });

  it("steps one frame either way, from the frame shown, and not past either end", () => {
    expect(stepTarget(5, 1, 30)).toBe(6);
    expect(stepTarget(5, -1, 30)).toBe(4);
    expect(stepTarget(0, -1, 30)).toBeUndefined();
    expect(stepTarget(29, 1, 30)).toBeUndefined();
    // At the end, the last frame is shown.
    expect(stepTarget(30, -1, 30)).toBe(28);
    expect(stepTarget(30, 1, 30)).toBeUndefined();
    expect(stepTarget(0, 1, 0)).toBeUndefined();
  });
});
