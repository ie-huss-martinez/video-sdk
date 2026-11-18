import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoCrop,
  type VideoPlan,
} from "../../core/model/plan.js";
import type { VideoRotation, VideoSourceInfo } from "../../core/model/source.js";
import { createVideoReducer } from "../../core/operations/commands.js";
import {
  clampCrop,
  clipPictureState,
  cropCommand,
  fitCommands,
  rotateCommands,
} from "./clip-picture.js";

const RATE = { num: 30, den: 1 };

function clip(
  key: string,
  source: string,
  change: Partial<VideoClip["transform"]> = {},
): VideoClip {
  return {
    key,
    source,
    start: 0,
    end: clipEnd(0, 30, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: { ...IDENTITY_TRANSFORM, ...change },
  };
}

const planOf = (...clips: VideoClip[]): VideoPlan => ({
  ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
  clips,
});

const source = (
  id: string,
  width: number,
  height: number,
  rotation: VideoRotation = 0,
): VideoSourceInfo => ({
  id,
  container: "webm",
  duration: 10_000_000,
  video: { codec: "vp8", width, height, rotation, frameRate: 30 },
  audio: null,
});

/** Applies commands with the real reducer, which refuses a crop its picture doesn't hold. */
function apply(plan: VideoPlan, sources: readonly VideoSourceInfo[], commands: readonly unknown[]) {
  const reducer = createVideoReducer((id) => sources.find((entry) => entry.id === id));
  let next = plan;
  for (const command of commands) next = reducer(next, command as never).state;
  return next;
}

describe("the selected clips' picture", () => {
  const wide = source("wide", 640, 360);
  const phone = source("phone", 640, 360, 90);

  it("gives one clip's rotation and fit, and the picture a crop is measured in", () => {
    const plan = planOf(clip("a", "wide", { fit: "cover" }), clip("b", "phone", { rotation: 90 }));
    expect(clipPictureState(plan, [wide, phone], ["a"])).toEqual({
      keys: ["a"],
      lead: plan.clips[0],
      rotation: 0,
      fit: "cover",
      frame: { width: 640, height: 360 },
    });
    // The source's own quarter turn, and the clip's: half a turn, wide again.
    expect(clipPictureState(plan, [wide, phone], ["b"]).frame).toEqual({ width: 640, height: 360 });
    expect(clipPictureState(planOf(clip("c", "phone")), [phone], ["c"]).frame).toEqual({
      width: 360,
      height: 640,
    });
  });

  it("gives null where several clips differ, and no frame to crop in", () => {
    const plan = planOf(clip("a", "wide"), clip("b", "phone", { rotation: 180, fit: "cover" }));
    expect(clipPictureState(plan, [wide, phone], ["a", "b"])).toMatchObject({
      keys: ["a", "b"],
      rotation: null,
      fit: null,
      frame: null,
    });
    expect(clipPictureState(plan, [wide], ["b"]).frame).toBeNull();
    expect(clipPictureState(null, [], ["a"])).toMatchObject({ keys: [], lead: null, frame: null });
  });
});

describe("turning clips", () => {
  const wide = source("wide", 640, 360);

  it("turns each clip from its own rotation, and keeps the others' fields", () => {
    const plan = planOf(
      clip("a", "wide"),
      clip("b", "wide", { rotation: 270, fit: "cover" }),
      clip("c", "wide"),
    );
    expect(rotateCommands(plan, [wide], ["a", "b"], 90)).toEqual([
      {
        type: "video.setTransform",
        keys: ["a"],
        transform: { rotation: 90, crop: null, fit: "contain" },
      },
      {
        type: "video.setTransform",
        keys: ["b"],
        transform: { rotation: 0, crop: null, fit: "cover" },
      },
    ]);
  });

  it("turns a crop with its picture, so it frames the same corner", () => {
    // The top-left 100 × 50 of a 640 × 360 picture.
    const plan = planOf(clip("a", "wide", { crop: { x: 0, y: 0, width: 100, height: 50 } }));
    const clockwise = apply(plan, [wide], rotateCommands(plan, [wide], ["a"], 90));
    // Turned clockwise, the picture is 360 × 640 and its old top-left is its top-right.
    expect(clockwise.clips[0]?.transform).toEqual({
      rotation: 90,
      crop: { x: 310, y: 0, width: 50, height: 100 },
      fit: "contain",
    });
    const anticlockwise = apply(plan, [wide], rotateCommands(plan, [wide], ["a"], 270));
    // Turned the other way, it's the bottom-left.
    expect(anticlockwise.clips[0]?.transform.crop).toEqual({
      x: 0,
      y: 540,
      width: 50,
      height: 100,
    });
  });

  it("always gives a crop the reducer accepts, and four turns give the crop back", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 400 }),
        fc.integer({ min: 4, max: 400 }),
        fc.constantFrom<VideoRotation>(0, 90, 180, 270),
        fc.constantFrom<VideoRotation>(0, 90, 180, 270),
        fc.constantFrom<90 | 270>(90, 270),
        fc.record({
          x: fc.double({ min: 0, max: 1, noNaN: true }),
          y: fc.double({ min: 0, max: 1, noNaN: true }),
          width: fc.double({ min: 0, max: 1, noNaN: true }),
          height: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        (width, height, sourceRotation, clipRotation, turn, part) => {
          const sources = [source("s", width, height, sourceRotation)];
          const start = planOf(clip("a", "s", { rotation: clipRotation }));
          const frame = clipPictureState(start, sources, ["a"]).frame as {
            width: number;
            height: number;
          };
          const crop = clampCrop(
            {
              x: part.x * frame.width,
              y: part.y * frame.height,
              width: part.width * frame.width,
              height: part.height * frame.height,
            },
            frame,
          );
          let plan = planOf(clip("a", "s", { rotation: clipRotation, crop }));
          // The reducer throws on a crop outside the turned picture.
          for (let turns = 0; turns < 4; turns += 1) {
            plan = apply(plan, sources, rotateCommands(plan, sources, ["a"], turn));
          }
          expect(plan.clips[0]?.transform).toEqual({
            rotation: clipRotation,
            crop,
            fit: "contain",
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("fit and crop", () => {
  const wide = source("wide", 640, 360);

  it("sets the fit of each selected clip, keeping its rotation and crop", () => {
    const crop: VideoCrop = { x: 10, y: 10, width: 100, height: 100 };
    const plan = planOf(clip("a", "wide", { rotation: 180, crop }), clip("b", "wide"));
    expect(fitCommands(plan, ["a", "b"], "cover")).toEqual([
      { type: "video.setTransform", keys: ["a"], transform: { rotation: 180, crop, fit: "cover" } },
      {
        type: "video.setTransform",
        keys: ["b"],
        transform: { rotation: 0, crop: null, fit: "cover" },
      },
    ]);
  });

  it("keeps a crop inside the picture, in whole pixels, at least 2 each way", () => {
    const frame = { width: 640, height: 360 };
    expect(clampCrop({ x: -5, y: 10.6, width: 9_999, height: 0 }, frame)).toEqual({
      x: 0,
      y: 11,
      width: 640,
      height: 2,
    });
    // The corner leaves room for the smallest crop.
    expect(clampCrop({ x: 9_999, y: 9_999, width: 50, height: 50 }, frame)).toEqual({
      x: 638,
      y: 358,
      width: 2,
      height: 2,
    });
    expect(
      clampCrop({ x: Number.NaN, y: 0, width: Number.POSITIVE_INFINITY, height: 4 }, frame),
    ).toEqual({ x: 0, y: 0, width: 2, height: 4 });
  });

  it("crops from the whole picture or the present crop, and a whole-picture crop is none", () => {
    const frame = { width: 640, height: 360 };
    const plain = clip("a", "wide");
    const first = cropCommand(plain, frame, { x: 100 });
    expect(first).toEqual({
      type: "video.setTransform",
      keys: ["a"],
      transform: { rotation: 0, crop: { x: 100, y: 0, width: 540, height: 360 }, fit: "contain" },
    });
    const cropped = apply(planOf(plain), [wide], [first]).clips[0] as VideoClip;
    expect(cropCommand(cropped, frame, { width: 200 })).toMatchObject({
      transform: { crop: { x: 100, y: 0, width: 200, height: 360 } },
    });
    expect(cropCommand(cropped, frame, { x: 0, width: 640 })).toMatchObject({
      transform: { crop: null },
    });
    expect(cropCommand(cropped, frame, null)).toMatchObject({ transform: { crop: null } });
  });
});
