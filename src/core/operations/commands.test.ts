import { applyCommands } from "@hussmartinez/sdk-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isVideoError } from "../errors/video-error.js";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  clipProblem,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  planFrames,
  type VideoClip,
  type VideoPlan,
  type VideoPlanOutput,
} from "../model/plan.js";
import { rotateSize, type VideoRotation, type VideoSourceInfo } from "../model/source.js";
import { type FrameRate, frameTime, isOnGrid } from "../model/time.js";
import { createVideoReducer, type VideoCommand } from "./commands.js";

function source(
  id: string,
  duration: number,
  width: number,
  height: number,
  rotation: VideoRotation = 0,
): VideoSourceInfo {
  return {
    id,
    container: "mp4",
    duration,
    video: { codec: "avc1.64001f", width, height, rotation, frameRate: 30 },
    audio: { codec: "mp4a.40.2", sampleRate: 48_000, channels: 2 },
  };
}

const SOURCES: readonly VideoSourceInfo[] = [
  source("a", 10_000_000, 1920, 1080),
  source("b", 7_300_000, 1280, 720, 90),
  source("c", 500_000, 640, 480),
];
const byId = new Map(SOURCES.map((info) => [info.id, info]));
const reducer = createVideoReducer((id) => byId.get(id));

const NTSC: FrameRate = { num: 30_000, den: 1_001 };
const RATES: readonly FrameRate[] = [
  NTSC,
  { num: 30, den: 1 },
  { num: 25, den: 1 },
  { num: 24_000, den: 1_001 },
  { num: 60, den: 1 },
];
const OUTPUT: VideoPlanOutput = {
  width: 1920,
  height: 1080,
  frameRate: NTSC,
  sampleRate: 48_000,
  channels: 2,
};

function clip(
  key: string,
  sourceId: string,
  start: number,
  frames: number,
  rate = NTSC,
): VideoClip {
  return {
    key,
    source: sourceId,
    start,
    end: clipEnd(start, frames, rate),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

function plan(...clips: VideoClip[]): VideoPlan {
  return { ...createPlan(OUTPUT), clips };
}

function rejection(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the command to be rejected");
}

function invalid(run: () => unknown): boolean {
  return isVideoError(rejection(run), "INVALID_COMMAND");
}

/** Freezes a value and everything in it, so any mutation by the reducer throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Every clip is valid over its source and on the plan's grid, and keys are unique. */
function expectValid(state: VideoPlan): void {
  const keys = state.clips.map((each) => each.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const each of state.clips) {
    expect(clipProblem(each, state.output.frameRate, byId.get(each.source)), each.key).toBe(
      undefined,
    );
    expect(isOnGrid(each.start, each.end, state.output.frameRate), each.key).toBe(true);
  }
}

describe("the video reducer, command by command", () => {
  const base = plan(clip("x", "a", 0, 30), clip("y", "b", 1_000_000, 60));

  it("inserts clips only where a clip starts or ends", () => {
    const inserted = reducer(base, {
      type: "video.insertClips",
      at: 30,
      clips: [clip("z", "c", 0, 3)],
    });
    expect(inserted.state.clips.map((each) => each.key)).toEqual(["x", "z", "y"]);
    expect(inserted.inverse).toEqual({ type: "video.removeClips", keys: ["z"] });
    expect(
      invalid(() =>
        reducer(base, { type: "video.insertClips", at: 10, clips: [clip("z", "c", 0, 3)] }),
      ),
    ).toBe(true);
    expect(
      invalid(() =>
        reducer(base, { type: "video.insertClips", at: 0, clips: [clip("x", "c", 0, 3)] }),
      ),
    ).toBe(true);
  });

  it("refuses clips off the grid, outside their source, or over an unknown source", () => {
    const offGrid = { ...clip("z", "a", 0, 10), end: clipEnd(0, 10, NTSC) + 5 };
    const pastEnd = clip("z", "c", 400_000, 10);
    const unknown = clip("z", "nope", 0, 10);
    for (const bad of [offGrid, pastEnd, unknown]) {
      expect(invalid(() => reducer(base, { type: "video.insertClips", at: 0, clips: [bad] }))).toBe(
        true,
      );
    }
  });

  it("splits a clip into two halves on the grid, even at 30000/1001", () => {
    const { state, inverse } = reducer(base, {
      type: "video.splitClip",
      key: "x",
      at: 1,
      newKey: "x2",
    });
    const [first, second] = state.clips;
    expect(first?.end).toBe(second?.start);
    expect(first && clipFrames(first, NTSC)).toBe(1);
    expect(second && clipFrames(second, NTSC)).toBe(29);
    // 29 frames at 30000/1001 is 967,633 µs, but the half is 967,634 µs long:
    // within the one microsecond the grid allows.
    expect(second && second.end - second.start).toBe(clipEnd(0, 30, NTSC) - clipEnd(0, 1, NTSC));
    expectValid(state);
    expect(reducer(state, inverse).state).toEqual(base);
    expect(
      invalid(() => reducer(base, { type: "video.splitClip", key: "x", at: 0, newKey: "n" })),
    ).toBe(true);
    expect(
      invalid(() => reducer(base, { type: "video.splitClip", key: "x", at: 30, newKey: "n" })),
    ).toBe(true);
  });

  it("deletes a range across clips, and inside one clip with a key for its second half", () => {
    const across = reducer(base, { type: "video.deleteRange", start: 20, end: 40, keys: [] });
    expect(across.state.clips.map((each) => clipFrames(each, NTSC))).toEqual([20, 50]);
    expect(reducer(across.state, across.inverse).state).toEqual(base);

    const inside = reducer(base, { type: "video.deleteRange", start: 40, end: 50, keys: ["y2"] });
    expect(inside.state.clips.map((each) => [each.key, clipFrames(each, NTSC)])).toEqual([
      ["x", 30],
      ["y", 10],
      ["y2", 40],
    ]);
    expectValid(inside.state);
    expect(reducer(inside.state, inside.inverse).state).toEqual(base);

    expect(
      invalid(() => reducer(base, { type: "video.deleteRange", start: 40, end: 50, keys: [] })),
    ).toBe(true);
    expect(
      invalid(() => reducer(base, { type: "video.deleteRange", start: 20, end: 40, keys: ["k"] })),
    ).toBe(true);
    expect(
      invalid(() => reducer(base, { type: "video.deleteRange", start: 0, end: 91, keys: [] })),
    ).toBe(true);
  });

  it("shortens fades on a trim, and undo restores them", () => {
    const faded = plan({
      ...clip("x", "a", 0, 30),
      fadeIn: { duration: 900_000, curve: "linear" },
    });
    const { state, inverse } = reducer(faded, {
      type: "video.trimClip",
      key: "x",
      start: 0,
      end: clipEnd(0, 10, NTSC),
    });
    expect(state.clips[0]?.fadeIn.duration).toBe(clipEnd(0, 10, NTSC));
    expect(reducer(state, inverse).state).toEqual(faded);
    expect(
      invalid(() => reducer(faded, { type: "video.trimClip", key: "x", start: 0, end: 1_000 })),
    ).toBe(true);
  });

  it("moves clips to a boundary of the plan without them", () => {
    const three = plan(clip("x", "a", 0, 10), clip("y", "a", 0, 20), clip("z", "a", 0, 30));
    const { state, inverse } = reducer(three, { type: "video.moveClips", keys: ["x"], to: 50 });
    expect(state.clips.map((each) => each.key)).toEqual(["y", "z", "x"]);
    expect(reducer(state, inverse).state).toEqual(three);
    expect(invalid(() => reducer(three, { type: "video.moveClips", keys: ["x"], to: 5 }))).toBe(
      true,
    );
  });

  it("checks a crop against the source as it's shown, after both rotations", () => {
    // Source b is 1280 × 720 and turned 90°, so it's shown 720 wide and 1280 tall.
    const turned = plan(clip("y", "b", 0, 30));
    const tall = { x: 0, y: 0, width: 720, height: 1280 };
    const apply = (rotation: VideoRotation) =>
      reducer(turned, {
        type: "video.setTransform",
        keys: ["y"],
        transform: { rotation, crop: tall, fit: "cover" },
      });
    expect(apply(0).state.clips[0]?.transform.crop).toEqual(tall);
    expect(invalid(() => apply(90))).toBe(true);
    expect(apply(180).state.clips[0]?.transform.rotation).toBe(180);
  });

  it("snaps every clip to a new frame rate, and undo restores the output and the clips", () => {
    const longFade = plan({
      ...clip("x", "a", 0, 30),
      fadeOut: { duration: 1_001_000, curve: "linear" },
    });
    const output = { ...OUTPUT, frameRate: { num: 25, den: 1 } };
    const { state, inverse } = reducer(longFade, { type: "video.setOutput", output });
    expect(state.output).toEqual(output);
    expect(state.clips[0] && clipFrames(state.clips[0], output.frameRate)).toBe(25);
    expectValid(state);
    expect(reducer(state, inverse).state).toEqual(longFade);
    expect(
      invalid(() =>
        reducer(longFade, { type: "video.setOutput", output: { ...OUTPUT, width: 1919 } }),
      ),
    ).toBe(true);
  });

  it("moves a clip's start back when even one frame of a new rate wouldn't fit its source", () => {
    // Clip z starts 37,412 µs before source c's 500,000 µs end, so one
    // 40,000 µs frame at 25 fps can't fit from its start.
    const nearEnd = plan(clip("z", "c", 462_588, 1));
    const output = { ...OUTPUT, frameRate: { num: 25, den: 1 } };
    const { state, inverse } = reducer(nearEnd, { type: "video.setOutput", output });
    expect(state.clips[0]).toMatchObject({ start: 460_000, end: 500_000 });
    expectValid(state);
    expect(reducer(state, inverse).state).toEqual(nearEnd);
    // A source shorter than one output frame can't hold a clip at that rate.
    expect(
      invalid(() =>
        reducer(nearEnd, {
          type: "video.setOutput",
          output: { ...OUTPUT, frameRate: { num: 1, den: 1 } },
        }),
      ),
    ).toBe(true);
  });

  it("sets volume, mute, fades and metadata, and refuses bad values", () => {
    expect(
      invalid(() => reducer(base, { type: "video.setVolume", keys: ["x"], volumeDb: 30 })),
    ).toBe(true);
    expect(
      invalid(() => reducer(base, { type: "video.setVolume", keys: ["x", "x"], volumeDb: 0 })),
    ).toBe(true);
    expect(
      invalid(() =>
        reducer(base, {
          type: "video.setFade",
          key: "x",
          edge: "in",
          duration: 2_000_000,
          curve: "linear",
        }),
      ),
    ).toBe(true);
    expect(
      invalid(() =>
        reducer(base, { type: "video.setMetadata", field: "location" as never, value: "here" }),
      ),
    ).toBe(true);
    expect(invalid(() => reducer(base, { type: "video.nope" } as never))).toBe(true);
    const { state, inverse } = reducer(base, { type: "video.setMuted", keys: ["y"], muted: true });
    expect(state.clips[1]?.muted).toBe(true);
    expect(reducer(state, inverse).state).toEqual(base);
  });
});

// ---------------------------------------------------------------------------
// Properties: commands built from random intents against the current plan,
// as the UI builds them.

const intent = fc.record({
  kind: fc.integer({ min: 0, max: 11 }),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
});
type Intent = typeof intent extends fc.Arbitrary<infer T> ? T : never;

/** The most whole output frames from `start` that fit in a source. */
function maxFrames(info: VideoSourceInfo, start: number, rate: FrameRate): number {
  let frames = Math.floor(((info.duration - start) * rate.num) / (1_000_000 * rate.den)) + 1;
  while (frames > 0 && clipEnd(start, frames, rate) > info.duration) frames -= 1;
  return frames;
}

function pick<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length] as T;
}

function subset(state: VideoPlan, seed: number): string[] {
  const keys = state.clips
    .filter((_, index) => ((seed >> index) & 1) === 1)
    .map((each) => each.key);
  return keys.length > 0 ? keys : state.clips.slice(0, 1).map((each) => each.key);
}

function newClip(key: string, rate: FrameRate, { a, b, c }: Intent): VideoClip | undefined {
  const info = pick(SOURCES, a);
  const start = (b * 7_919) % Math.max(1, info.duration - 100_000);
  const fit = maxFrames(info, start, rate);
  if (fit < 1) return undefined;
  const made = clip(key, info.id, start, 1 + (c % Math.min(fit, 90)), rate);
  const length = made.end - made.start;
  return {
    ...made,
    volumeDb: (c % 121) - 96,
    muted: c % 5 === 0,
    fadeIn: { duration: Math.floor(length * ((a % 4) / 8)), curve: "equalPower" },
    fadeOut: { duration: Math.floor(length * ((b % 4) / 8)), curve: "linear" },
  };
}

let counter = 0;

function build(state: VideoPlan, step: Intent): VideoCommand | undefined {
  const rate = state.output.frameRate;
  const total = planFrames(state);
  const offsets = clipOffsets(state);
  const target = state.clips.length > 0 ? pick(state.clips, step.a) : undefined;
  const fresh = () => {
    counter += 1;
    return `k${counter}`;
  };
  switch (step.kind) {
    case 0: {
      const made = newClip(fresh(), rate, step);
      if (!made) return undefined;
      return { type: "video.insertClips", at: pick([...offsets, total], step.b), clips: [made] };
    }
    case 1:
      return target && { type: "video.removeClips", keys: subset(state, step.b) };
    case 2: {
      if (total === 0) return undefined;
      const start = step.a % total;
      const end = start + 1 + (step.b % (total - start));
      const inside = state.clips.some((each, index) => {
        const from = offsets[index] ?? 0;
        return from < start && from + clipFrames(each, rate) > end;
      });
      return { type: "video.deleteRange", start, end, keys: inside ? [fresh()] : [] };
    }
    case 3: {
      if (!target) return undefined;
      const info = byId.get(target.source) as VideoSourceInfo;
      const start = (step.b * 104_729) % Math.max(1, info.duration - 50_000);
      const fit = maxFrames(info, start, rate);
      if (fit < 1) return undefined;
      return {
        type: "video.trimClip",
        key: target.key,
        start,
        end: clipEnd(start, 1 + (step.c % Math.min(fit, 120)), rate),
      };
    }
    case 4: {
      if (!target) return undefined;
      const frames = clipFrames(target, rate);
      if (frames < 2) return undefined;
      const index = state.clips.indexOf(target);
      return {
        type: "video.splitClip",
        key: target.key,
        at: (offsets[index] ?? 0) + 1 + (step.b % (frames - 1)),
        newKey: fresh(),
      };
    }
    case 5: {
      if (!target) return undefined;
      const keys = subset(state, step.b);
      const rest = { ...state, clips: state.clips.filter((each) => !keys.includes(each.key)) };
      return {
        type: "video.moveClips",
        keys,
        to: pick([...clipOffsets(rest), planFrames(rest)], step.c),
      };
    }
    case 6:
      return (
        target && {
          type: "video.setVolume",
          keys: subset(state, step.b),
          volumeDb: (step.c % 1_201) / 10 - 96,
        }
      );
    case 7:
      return (
        target && { type: "video.setMuted", keys: subset(state, step.b), muted: step.c % 2 === 0 }
      );
    case 8: {
      if (!target) return undefined;
      const edge = step.b % 2 === 0 ? "in" : "out";
      const other = edge === "in" ? target.fadeOut.duration : target.fadeIn.duration;
      const room = target.end - target.start - other;
      return {
        type: "video.setFade",
        key: target.key,
        edge,
        duration: step.c % (room + 1),
        curve: step.c % 2 === 0 ? "linear" : "equalPower",
      };
    }
    case 9: {
      if (!target) return undefined;
      const info = byId.get(target.source) as VideoSourceInfo;
      const rotation = pick([0, 90, 180, 270] as const, step.b);
      const shown = rotateSize(
        info.video,
        ((info.video.rotation + rotation) % 360) as VideoRotation,
      );
      const width = 2 + (step.c % (shown.width - 1));
      const height = 2 + ((step.c >> 3) % (shown.height - 1));
      const crop =
        step.a % 3 === 0
          ? null
          : {
              x: step.b % (shown.width - width + 1),
              y: step.c % (shown.height - height + 1),
              width,
              height,
            };
      return {
        type: "video.setTransform",
        keys: [target.key],
        transform: { rotation, crop, fit: step.c % 2 === 0 ? "contain" : "cover" },
      };
    }
    case 10:
      return {
        type: "video.setOutput",
        output: {
          width: 2 * (1 + (step.a % 2_048)),
          height: 2 * (1 + (step.b % 2_048)),
          frameRate: pick(RATES, step.c),
          sampleRate: pick([44_100, 48_000, 96_000], step.a),
          channels: 1 + (step.b % 8),
        },
      };
    default:
      return {
        type: "video.setMetadata",
        field: pick(["title", "description", "artist", "date", "comment"] as const, step.a),
        value: "x".repeat(step.b % 50),
      };
  }
}

const start = plan(clip("x", "a", 0, 30), clip("y", "b", 1_000_000, 60), clip("z", "c", 0, 10));

describe("the video reducer, as properties", () => {
  it("keeps every clip valid and on the frame grid after every command", () => {
    const applied = new Map<string, number>();
    fc.assert(
      fc.property(fc.array(intent, { maxLength: 30 }), (steps) => {
        let state = start;
        for (const step of steps) {
          const command = build(state, step);
          if (command === undefined) continue;
          const { state: after, inverse } = reducer(state, command);
          expectValid(after);
          for (const type of [command.type, inverse.type]) {
            applied.set(type, (applied.get(type) ?? 0) + 1);
          }
          state = after;
        }
      }),
      { numRuns: 300 },
    );
    // Every command type, including restoreClips as an inverse, ran many times.
    expect([...applied.keys()].sort()).toEqual(
      [
        "video.deleteRange",
        "video.insertClips",
        "video.moveClips",
        "video.removeClips",
        "video.restoreClips",
        "video.setFade",
        "video.setMetadata",
        "video.setMuted",
        "video.setOutput",
        "video.setTransform",
        "video.setVolume",
        "video.splitClip",
        "video.trimClip",
      ].sort(),
    );
    for (const [type, count] of applied) expect(count, type).toBeGreaterThan(50);
  });

  it("undoes any command with its inverse, back to exactly the plan before it", () => {
    fc.assert(
      fc.property(fc.array(intent, { maxLength: 30 }), (steps) => {
        let state = start;
        for (const step of steps) {
          const command = build(state, step);
          if (command === undefined) continue;
          const before = deepFreeze(state);
          const { state: after, inverse } = reducer(before, command);
          expect(reducer(after, inverse).state).toEqual(before);
          state = after;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("undoes a whole sequence with the inverses applyCommands returns", () => {
    fc.assert(
      fc.property(fc.array(intent, { maxLength: 30 }), (steps) => {
        const commands: VideoCommand[] = [];
        let state = start;
        for (const step of steps) {
          const command = build(state, step);
          if (command === undefined) continue;
          state = reducer(state, command).state;
          commands.push(command);
        }
        const done = applyCommands(reducer, start, commands);
        expect(applyCommands(reducer, done.state, done.inverses).state).toEqual(start);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects an invalid command with INVALID_COMMAND, and never changes the plan it was given", () => {
    const broken: fc.Arbitrary<VideoCommand> = fc.oneof(
      fc.record({
        type: fc.constant("video.trimClip" as const),
        key: fc.constant("x"),
        start: fc.nat(),
        end: fc.nat(),
      }),
      fc.record({
        type: fc.constant("video.splitClip" as const),
        key: fc.constant("x"),
        at: fc.integer(),
        newKey: fc.constantFrom("y", ""),
      }),
      fc.record({
        type: fc.constant("video.deleteRange" as const),
        start: fc.integer(),
        end: fc.integer(),
        keys: fc.constant(["x"]),
      }),
      fc.record({
        type: fc.constant("video.insertClips" as const),
        at: fc.integer({ min: 1, max: 29 }),
        clips: fc.constant([clip("n", "a", 0, 1)]),
      }),
      fc.record({
        type: fc.constant("video.setVolume" as const),
        keys: fc.constant(["x"]),
        volumeDb: fc.oneof(fc.constant(Number.NaN), fc.double({ min: 24.001, max: 1e9 })),
      }),
    );
    fc.assert(
      fc.property(broken, (command) => {
        const frozen = deepFreeze(structuredClone(start));
        let error: unknown;
        try {
          const { state } = reducer(frozen, command);
          // A command the generator happened to make valid must still keep the plan valid.
          expectValid(state);
          return;
        } catch (caught) {
          error = caught;
        }
        expect(isVideoError(error, "INVALID_COMMAND")).toBe(true);
        expect(frozen).toEqual(start);
      }),
      { numRuns: 500 },
    );
  });
});

describe("frameTime and the grid", () => {
  it("rounds each frame start to the microsecond, so consecutive lengths differ by at most one", () => {
    fc.assert(
      fc.property(fc.nat(500_000), fc.nat(500_000), (a, b) => {
        const whole = frameTime(a + b, NTSC);
        expect(Math.abs(whole - frameTime(a, NTSC) - frameTime(b, NTSC))).toBeLessThanOrEqual(1);
      }),
    );
  });
});
