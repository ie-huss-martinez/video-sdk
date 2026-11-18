import { describe, expect, it } from "vitest";
import { videoLimits } from "../../core/errors/video-limits.js";
import { createPlan, type VideoPlan, type VideoPlanOutput } from "../../core/model/plan.js";
import {
  changedOutput,
  channelChoices,
  metadataCommand,
  metadataProblem,
  outputCommand,
  outputProblem,
  sampleRateChoices,
} from "./output-settings.js";

const OUTPUT: VideoPlanOutput = {
  width: 1280,
  height: 720,
  frameRate: { num: 30, den: 1 },
  sampleRate: 48_000,
  channels: 2,
};
const plan: VideoPlan = createPlan(OUTPUT);

describe("changing the output", () => {
  it("rounds sizes down to even numbers of at least 2, and snaps the frame rate", () => {
    expect(changedOutput(OUTPUT, { width: 1919.9, height: 1 })).toMatchObject({
      width: 1918,
      height: 2,
    });
    expect(changedOutput(OUTPUT, { width: Number.NaN }).width).toBe(2);
    expect(changedOutput(OUTPUT, { framesPerSecond: 29.97 }).frameRate).toEqual({
      num: 30_000,
      den: 1_001,
    });
    expect(changedOutput(OUTPUT, { framesPerSecond: 12.4 }).frameRate).toEqual({ num: 12, den: 1 });
    // A rate that isn't a rate keeps the one there is.
    expect(changedOutput(OUTPUT, { framesPerSecond: 0 }).frameRate).toEqual(OUTPUT.frameRate);
    expect(changedOutput(OUTPUT, { sampleRate: 44_100, channels: 1 })).toEqual({
      ...OUTPUT,
      sampleRate: 44_100,
      channels: 1,
    });
  });

  it("is no command when nothing changes", () => {
    expect(outputCommand(plan, changedOutput(OUTPUT, { width: 1281 }))).toBeNull();
    expect(outputCommand(plan, changedOutput(OUTPUT, { framesPerSecond: 30.01 }))).toBeNull();
    expect(outputCommand(plan, changedOutput(OUTPUT, { width: 640 }))).toEqual({
      type: "video.setOutput",
      output: { ...OUTPUT, width: 640 },
    });
  });

  it("says what the policy would refuse, before the session does", () => {
    const policy = videoLimits.resolve();
    expect(outputProblem(policy, OUTPUT)).toBeUndefined();
    expect(outputProblem(policy, { ...OUTPUT, width: 7680, height: 4320 })).toEqual({
      reason: "too-large",
      maximum: policy.limits.maxFramePixels.maximum,
    });
    expect(outputProblem(policy, { ...OUTPUT, frameRate: { num: 240, den: 1 } })).toEqual({
      reason: "rate-too-high",
      maximum: 120,
    });
    expect(outputProblem(videoLimits.resolve({ maxFramePixels: 640 * 360 }), OUTPUT)).toMatchObject(
      { reason: "too-large", maximum: 640 * 360 },
    );
  });

  it("offers 44.1 and 48 kHz, mono and stereo, and the output's own values", () => {
    expect(sampleRateChoices(OUTPUT)).toEqual([44_100, 48_000]);
    expect(sampleRateChoices({ ...OUTPUT, sampleRate: 96_000 })).toEqual([44_100, 48_000, 96_000]);
    expect(channelChoices(OUTPUT)).toEqual([1, 2]);
    expect(channelChoices({ ...OUTPUT, channels: 6 })).toEqual([1, 2, 6]);
  });
});

describe("metadata", () => {
  it("allows text up to 1,000 code points, counting an emoji as one", () => {
    expect(metadataProblem("title", "🎬".repeat(1_000))).toBeUndefined();
    expect(metadataProblem("title", "🎬".repeat(1_001))).toBe("too-long");
    expect(metadataProblem("comment", "")).toBeUndefined();
  });

  it("takes a date only as a real calendar date, YYYY-MM-DD, or nothing", () => {
    expect(metadataProblem("date", "2026-11-18")).toBeUndefined();
    expect(metadataProblem("date", "2024-02-29")).toBeUndefined();
    expect(metadataProblem("date", "")).toBeUndefined();
    for (const value of ["2025-02-29", "2026-13-01", "18/11/2026", "2026-11-18T10:00", "soon"]) {
      expect(metadataProblem("date", value), value).toBe("not-a-date");
    }
    // Other fields take any text.
    expect(metadataProblem("title", "18/11/2026")).toBeUndefined();
  });

  it("is a command only for a change that can be made", () => {
    expect(metadataCommand(plan, "title", "Take 1")).toEqual({
      type: "video.setMetadata",
      field: "title",
      value: "Take 1",
    });
    expect(metadataCommand(plan, "title", "")).toBeNull();
    expect(metadataCommand(plan, "date", "tomorrow")).toBeNull();
  });
});
