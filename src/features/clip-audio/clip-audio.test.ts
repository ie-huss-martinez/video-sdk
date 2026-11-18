import { describe, expect, it } from "vitest";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoPlan,
} from "../../core/model/plan.js";
import type { VideoSourceInfo } from "../../core/model/source.js";
import { createVideoReducer } from "../../core/operations/commands.js";
import { clipAudioState, fadeCommands } from "./clip-audio.js";

const RATE = { num: 30, den: 1 };
const SECOND = 1_000_000;

function clip(key: string, frames: number, change: Partial<VideoClip> = {}): VideoClip {
  return {
    key,
    source: "s",
    start: 0,
    end: clipEnd(0, frames, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
    ...change,
  };
}

const planOf = (...clips: VideoClip[]): VideoPlan => ({
  ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
  clips,
});

const source = (id: string, audio: boolean): VideoSourceInfo => ({
  id,
  container: "webm",
  duration: 10 * SECOND,
  video: { codec: "vp8", width: 64, height: 36, rotation: 0, frameRate: 30 },
  audio: audio ? { codec: "opus", sampleRate: 48_000, channels: 2 } : null,
});

describe("the selected clips' sound", () => {
  it("gives one clip's own values, and how long each fade can be", () => {
    const plan = planOf(
      clip("a", 60, {
        volumeDb: -6,
        muted: true,
        fadeIn: { duration: 500_000, curve: "equalPower" },
      }),
    );
    expect(clipAudioState(plan, [source("s", true)], ["a"])).toEqual({
      keys: ["a"],
      lead: plan.clips[0],
      hasAudio: true,
      volumeDb: -6,
      muted: true,
      fadeIn: { duration: 500_000, curve: "equalPower", max: 2 * SECOND },
      // What the fade in leaves of the clip's two seconds.
      fadeOut: { duration: 0, curve: "linear", max: 1_500_000 },
    });
  });

  it("gives null where several clips differ, and the shortest clip's room for a fade", () => {
    const plan = planOf(
      clip("a", 60, { volumeDb: -6 }),
      clip("b", 30, { muted: true, fadeOut: { duration: 200_000, curve: "equalPower" } }),
      clip("c", 90),
    );
    const state = clipAudioState(plan, [source("s", true)], ["b", "a"]);
    expect(state.keys).toEqual(["a", "b"]);
    expect(state.lead?.key).toBe("a");
    expect(state.volumeDb).toBeNull();
    expect(state.muted).toBeNull();
    expect(state.fadeIn).toEqual({ duration: 0, curve: "linear", max: 800_000 });
    expect(state.fadeOut).toEqual({ duration: null, curve: null, max: SECOND });
  });

  it("leaves out keys the plan doesn't have, and says when no clip has sound", () => {
    const plan = planOf(clip("a", 60));
    expect(clipAudioState(plan, [source("s", false)], ["a", "gone"])).toMatchObject({
      keys: ["a"],
      hasAudio: false,
    });
    expect(clipAudioState(plan, [source("s", true)], [])).toMatchObject({
      keys: [],
      lead: null,
      hasAudio: false,
      volumeDb: null,
      muted: null,
    });
    expect(clipAudioState(null, [], ["a"]).keys).toEqual([]);
  });

  it("treats hostile keys as ordinary keys", () => {
    const plan = planOf(clip("__proto__", 30), clip("constructor", 30, { volumeDb: 3 }));
    expect(clipAudioState(plan, [source("s", true)], ["constructor"])).toMatchObject({
      keys: ["constructor"],
      volumeDb: 3,
    });
  });
});

describe("the commands that set a fade", () => {
  const reducer = createVideoReducer(() => ({
    duration: 10 * SECOND,
    video: { width: 64, height: 36, rotation: 0 },
  }));

  it("sets each selected clip's fade, keeping what isn't given", () => {
    const plan = planOf(
      clip("a", 60, { fadeIn: { duration: 100_000, curve: "equalPower" } }),
      clip("b", 60),
      clip("c", 60),
    );
    expect(fadeCommands(plan, ["a", "b"], "in", { duration: 300_000 })).toEqual([
      { type: "video.setFade", key: "a", edge: "in", duration: 300_000, curve: "equalPower" },
      { type: "video.setFade", key: "b", edge: "in", duration: 300_000, curve: "linear" },
    ]);
    expect(fadeCommands(plan, ["a"], "in", { curve: "linear" })).toEqual([
      { type: "video.setFade", key: "a", edge: "in", duration: 100_000, curve: "linear" },
    ]);
  });

  it("keeps each fade within its own clip, in whole microseconds, so the reducer accepts it", () => {
    const plan = planOf(
      clip("short", 15, { fadeOut: { duration: 200_000, curve: "linear" } }),
      clip("long", 90),
    );
    const commands = fadeCommands(plan, ["short", "long"], "in", { duration: 2 * SECOND + 0.4 });
    expect(commands.map((command) => "duration" in command && command.duration)).toEqual([
      300_000,
      2 * SECOND,
    ]);
    let next = plan;
    for (const command of commands) next = reducer(next, command).state;
    expect(next.clips[0]?.fadeIn.duration).toBe(300_000);
    expect(fadeCommands(plan, ["long"], "out", { duration: -5 })[0]).toMatchObject({ duration: 0 });
  });
});
