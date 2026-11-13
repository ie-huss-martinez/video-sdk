import { describe, expect, it } from "vitest";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  planFrames,
  type VideoClip,
  type VideoPlan,
} from "../core/model/plan.js";
import { frameTime } from "../core/model/time.js";
import { createVideoReducer } from "../core/operations/commands.js";
import {
  edgeLimits,
  moveTarget,
  offsetsOf,
  selectRange,
  trimEdge,
  trimToPlayhead,
} from "./timeline-model.js";

const NTSC = { num: 30_000, den: 1_001 };

function clip(key: string, startFrame: number, frames: number): VideoClip {
  const start = frameTime(startFrame, NTSC);
  return {
    key,
    source: "s",
    start,
    end: clipEnd(start, frames, NTSC),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

function planOf(...clips: VideoClip[]): VideoPlan {
  return {
    ...createPlan({ width: 64, height: 36, frameRate: NTSC, sampleRate: 48_000, channels: 2 }),
    clips,
  };
}

const plan = planOf(clip("a", 0, 10), clip("b", 100, 20), clip("c", 300, 30));
const sources = new Map([
  [
    "s",
    {
      id: "s",
      container: "mp4" as const,
      duration: 100_000_000,
      video: { codec: "avc1", width: 64, height: 36, rotation: 0 as const, frameRate: 30 },
      audio: null,
    },
  ],
]);
const reduce = createVideoReducer((id: string) => sources.get(id));

describe("the timeline's keyboard edits", () => {
  it("moves selected clips one place left or right, and not past either end", () => {
    expect(moveTarget(plan, ["b"], -1)).toBe(0);
    expect(moveTarget(plan, ["b"], 1)).toBe(40);
    expect(moveTarget(plan, ["a"], -1)).toBeUndefined();
    expect(moveTarget(plan, ["c"], 1)).toBeUndefined();
    expect(moveTarget(plan, ["a", "b"], 1)).toBe(30);
    expect(moveTarget(plan, [], 1)).toBeUndefined();
    // And the reducer accepts each target.
    const moved = reduce(plan, { type: "video.moveClips", keys: ["b"], to: 40 }).state;
    expect(moved.clips.map((each) => each.key)).toEqual(["a", "c", "b"]);
  });

  it("trims an edge to the playhead only strictly inside the clip, on the grid", () => {
    // Clip b is timeline frames 10 to 29.
    const start = trimToPlayhead(plan, 1, 15, "start");
    expect(start).toEqual({ start: frameTime(105, NTSC), end: plan.clips[1]?.end });
    const end = trimToPlayhead(plan, 1, 15, "end");
    expect(end).toEqual({
      start: plan.clips[1]?.start,
      end: clipEnd(frameTime(100, NTSC), 5, NTSC),
    });
    expect(trimToPlayhead(plan, 1, 10, "start")).toBeUndefined();
    expect(trimToPlayhead(plan, 1, 30, "end")).toBeUndefined();
    // Five frames in: the start trim keeps 15 of b's 20 frames, the end trim 5.
    for (const [range, total] of [
      [start, 10 + 15 + 30],
      [end, 10 + 5 + 30],
    ] as const) {
      const trimmed = reduce(plan, {
        type: "video.trimClip",
        key: "b",
        ...(range as object),
      } as never);
      expect(planFrames(trimmed.state)).toBe(total);
    }
  });

  it("nudges an edge a frame either way, staying on the grid", () => {
    for (const [edge, delta, frames] of [
      ["start", 1, 21],
      ["start", -1, 19],
      ["end", 1, 21],
      ["end", -1, 19],
    ] as const) {
      const range = trimEdge(plan, 1, edge, delta);
      expect(range, `${edge} ${delta}`).toBeDefined();
      const next = reduce(plan, {
        type: "video.trimClip",
        key: "b",
        ...(range as object),
      } as never);
      expect(planFrames(next.state)).toBe(10 + frames + 30);
    }
    // A clip at its source's start can't start earlier; one frame can't get shorter.
    expect(trimEdge(plan, 0, "start", 1)).toBeUndefined();
    expect(trimEdge(planOf(clip("x", 0, 1)), 0, "end", -1)).toBeUndefined();
  });

  it("limits a dragged edge to a one-frame clip and to its source, and every limit is accepted", () => {
    const duration = sources.get("s")?.duration ?? 0;
    // Clip b is source frames 100 to 119; the source is about 2997 frames long.
    const start = edgeLimits(plan, 1, "start", duration);
    expect(start).toEqual({ min: -19, max: 100 });
    const end = edgeLimits(plan, 1, "end", duration);
    expect(end.min).toBe(-19);
    for (const [edge, limits] of [
      ["start", start],
      ["end", end],
    ] as const) {
      for (const delta of [limits.min, limits.max]) {
        const range = trimEdge(plan, 1, edge, delta);
        expect(range, `${edge} ${delta}`).toBeDefined();
        expect(range?.end ?? Infinity).toBeLessThanOrEqual(duration);
        const next = reduce(plan, {
          type: "video.trimClip",
          key: "b",
          ...(range as object),
        } as never);
        expect(planFrames(next.state)).toBe(10 + 20 + delta + 30);
      }
    }
    // One past the end's limit is past the source.
    expect(trimEdge(plan, 1, "end", end.max + 1)?.end).toBeGreaterThan(duration);
  });

  it("lays clips out from sdk-core's sequence offsets", () => {
    expect(offsetsOf(plan)).toEqual([0, 10, 30, 60]);
  });

  it("selects a range in plan order, either way", () => {
    expect(selectRange(plan, 2, 0)).toEqual(["a", "b", "c"]);
    expect(selectRange(plan, 1, 1)).toEqual(["b"]);
  });
});
