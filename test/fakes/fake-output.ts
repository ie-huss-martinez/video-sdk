import { checkedBackingSize } from "../../src/core/playback/backing.js";
import {
  planFrames,
  type VideoOutput,
  type VideoOutputSnapshot,
  type VideoPlan,
  videoLimits,
} from "../../src/index.js";

/** A manual clock for the fake output, in output frames. */
export interface FakeClock {
  /** Moves time forward. Playback advances with it while playing. */
  advance(frames: number): void;
}

/** A playback fake: the real output's state machine, driven by a manual clock. */
export function createFakeOutput(): { output: VideoOutput; clock: FakeClock } {
  const listeners = new Set<() => void>();
  let snapshot: VideoOutputSnapshot = {
    state: "stopped",
    droppedFrames: 0,
    error: null,
    audio: "ready",
  };
  const ended = new Set<() => void>();
  let plan: VideoPlan | undefined;
  let playhead = 0;
  let destroyed = false;

  const length = () => (plan ? planFrames(plan) : 0);
  const assertAlive = () => {
    if (destroyed) throw new Error("The output has been destroyed.");
  };
  const setState = (state: VideoOutputSnapshot["state"]) => {
    if (snapshot.state === state) return;
    snapshot = { ...snapshot, state };
    for (const listener of [...listeners]) listener();
  };

  const output: VideoOutput = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    position: () => playhead,
    load(next) {
      assertAlive();
      plan = next;
      playhead = Math.min(playhead, length());
    },
    async play() {
      assertAlive();
      if (length() === 0) return;
      if (playhead >= length()) playhead = 0;
      setState("playing");
    },
    pause() {
      assertAlive();
      if (snapshot.state === "playing") setState("paused");
    },
    stop() {
      assertAlive();
      playhead = 0;
      setState("stopped");
    },
    seek(frame) {
      assertAlive();
      playhead = Math.max(0, Math.min(Math.round(frame), length()));
    },
    step(delta) {
      assertAlive();
      const target = Math.min(playhead, length() - 1) + delta;
      if (length() === 0 || target < 0 || target > length() - 1) return;
      if (snapshot.state === "playing") setState("paused");
      playhead = target;
    },
    resize(width, height, pixelRatio) {
      assertAlive();
      checkedBackingSize(videoLimits.resolve(), width, height, pixelRatio);
    },
    on(_event, listener) {
      ended.add(listener);
      return () => ended.delete(listener);
    },
    async destroy() {
      destroyed = true;
      setState("stopped");
      listeners.clear();
      ended.clear();
    },
  };

  const clock: FakeClock = {
    advance(frames) {
      if (snapshot.state !== "playing") return;
      playhead = Math.min(playhead + frames, length());
      if (playhead >= length()) {
        setState("stopped");
        for (const listener of [...ended]) listener();
      }
    },
  };

  return { output, clock };
}
