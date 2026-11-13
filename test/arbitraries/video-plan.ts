import fc from "fast-check";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  planFrames,
  type VideoClip,
  type VideoPlan,
  type VideoPlanOutput,
} from "../../src/core/model/plan.js";
import {
  rotateSize,
  type VideoRotation,
  type VideoSourceInfo,
} from "../../src/core/model/source.js";
import type { FrameRate } from "../../src/core/model/time.js";
import { createVideoReducer, type VideoCommand } from "../../src/core/operations/commands.js";

/**
 * The video reducer's property-test generators (ADR 0003): sources, plans
 * and commands built from random intents against the current plan, as the
 * UI builds them. The reducer's own tests and the conformance vectors'
 * generator share them (sdk-core ADR 0045).
 */

export function source(
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

export const SOURCES: readonly VideoSourceInfo[] = [
  source("a", 10_000_000, 1920, 1080),
  source("b", 7_300_000, 1280, 720, 90),
  source("c", 500_000, 640, 480),
];
export const byId = new Map(SOURCES.map((info) => [info.id, info]));
export const reducer = createVideoReducer((id) => byId.get(id));

export const NTSC: FrameRate = { num: 30_000, den: 1_001 };
export const RATES: readonly FrameRate[] = [
  NTSC,
  { num: 30, den: 1 },
  { num: 25, den: 1 },
  { num: 24_000, den: 1_001 },
  { num: 60, den: 1 },
];
export const OUTPUT: VideoPlanOutput = {
  width: 1920,
  height: 1080,
  frameRate: NTSC,
  sampleRate: 48_000,
  channels: 2,
};

export function clip(
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

export function plan(...clips: VideoClip[]): VideoPlan {
  return { ...createPlan(OUTPUT), clips };
}

export const intent = fc.record({
  kind: fc.integer({ min: 0, max: 11 }),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
});
export type Intent = typeof intent extends fc.Arbitrary<infer T> ? T : never;

/** The most whole output frames from `start` that fit in a source. */
export function maxFrames(info: VideoSourceInfo, start: number, rate: FrameRate): number {
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

export function build(state: VideoPlan, step: Intent): VideoCommand | undefined {
  const rate = state.output.frameRate;
  const total = planFrames(state);
  const offsets = clipOffsets(state);
  const target = state.clips.length > 0 ? pick(state.clips, step.a) : undefined;
  // A key the plan doesn't have, the same for the same plan, so generated
  // cases are reproducible from their seed.
  const fresh = () => {
    const taken = new Set(state.clips.map((each) => each.key));
    let n = state.clips.length + 1;
    while (taken.has(`k${n}`)) n += 1;
    return `k${n}`;
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

export const START = plan(
  clip("x", "a", 0, 30),
  clip("y", "b", 1_000_000, 60),
  clip("z", "c", 0, 10),
);

/** A plan reached from {@link START} by up to `maxSteps` generated commands. */
export const planArb: fc.Arbitrary<VideoPlan> = fc.array(intent, { maxLength: 12 }).map((steps) => {
  let state = START;
  for (const step of steps) {
    const command = build(state, step);
    if (command !== undefined) state = reducer(state, command).state;
  }
  return state;
});

/** A command for a plan, as the UI would build it. */
export const commandFor = (state: VideoPlan): fc.Arbitrary<VideoCommand> =>
  intent
    .map((step) => build(state, step))
    .filter((command): command is VideoCommand => command !== undefined);
