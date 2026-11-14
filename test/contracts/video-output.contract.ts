import { describe, expect, it } from "vitest";
import { isVideoError, type VideoOutput, type VideoSourceInfo } from "../../src/index.js";
import { clipOf, planOf } from "./helpers.js";

/**
 * What an output's contract test needs: a way to create the output over an
 * open source of at least 4 seconds, and to let time pass while it plays.
 * The real adapter waits on the playback clock; the fake advances a manual
 * one.
 */
export interface VideoOutputHarness {
  create(): Promise<{
    readonly output: VideoOutput;
    readonly source: VideoSourceInfo;
    /**
     * Lets about `frames` of time pass, and returns how many frames actually
     * passed: a busy browser's timers run late, so the playhead is expected
     * where the measured time puts it, not where the intended time would.
     */
    elapse(frames: number): Promise<number>;
  }>;
  /**
   * How far the playhead may be from where the measured time puts it, in
   * frames: the clock's own scheduling, not the runner's. 0 for a manual clock.
   */
  readonly positionTolerance: number;
}

/**
 * Waits, a frame at a time, until the playhead has moved past `frame`, as it
 * does once playing resumes after a seek or a new plan, and returns where it
 * is then. A manual clock passes at once; a loaded runner may take a while.
 */
async function resumedAfter(
  output: VideoOutput,
  frame: number,
  elapse: (frames: number) => Promise<number>,
): Promise<number> {
  for (let tries = 0; tries < 300 && output.position() <= frame; tries += 1) await elapse(1);
  return output.position();
}

/**
 * The behaviour every {@link VideoOutput} must have (ADR 0002, ADR 0003,
 * ADR 0005, ADR 0008). Adapters run it with their own harness.
 */
export function describeVideoOutputContract(name: string, harness: VideoOutputHarness): void {
  describe(`${name}: the VideoOutput contract`, () => {
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(harness.positionTolerance);

    it("starts stopped at the start, with nothing dropped", async () => {
      const { output } = await harness.create();
      expect(output.getSnapshot()).toEqual({
        state: "stopped",
        droppedFrames: 0,
        error: null,
        audio: "ready",
      });
      expect(output.position()).toBe(0);
      await output.destroy();
    });

    it("plays, notifying subscribers, and moves the playhead with the clock", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      const states: string[] = [];
      // A subscriber is also notified of other changes, such as dropped frames: record state changes only.
      output.subscribe(() => {
        const { state } = output.getSnapshot();
        if (states.at(-1) !== state) states.push(state);
      });
      await output.play();
      const passed = await elapse(30);
      expect(states).toEqual(["playing"]);
      near(output.position(), Math.min(passed, 90));
      await output.destroy();
    });

    it("pauses and resumes from the same frame", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      await output.play();
      await elapse(30);
      output.pause();
      const paused = output.position();
      await elapse(30);
      expect(output.getSnapshot().state).toBe("paused");
      expect(output.position()).toBe(paused);
      await output.play();
      const passed = await elapse(15);
      near(output.position(), Math.min(paused + passed, 90));
      await output.destroy();
    });

    it("stops at the end of the last clip, and plays again from the start", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 20), clipOf("y", source, 1_000_000, 10)));
      await output.play();
      await elapse(60);
      expect(output.getSnapshot().state).toBe("stopped");
      expect(output.position()).toBe(30);
      await output.play();
      const passed = await elapse(5);
      near(output.position(), Math.min(passed, 30));
      await output.destroy();
    });

    it("fires ended once when playback reaches the end, and never on a seek to it", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 15)));
      let ended = 0;
      const off = output.on("ended", () => {
        ended += 1;
      });
      output.seek(15);
      await elapse(5);
      expect(ended).toBe(0);
      await output.play();
      await elapse(30);
      expect(ended).toBe(1);
      expect(output.getSnapshot().state).toBe("stopped");
      expect(output.position()).toBe(15);
      await elapse(15);
      expect(ended).toBe(1);
      off();
      await output.play();
      await elapse(30);
      expect(ended).toBe(1);
      await output.destroy();
    });

    it("steps one frame either way, pausing, and not past either end", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 30)));
      output.step(-1);
      expect(output.position()).toBe(0);
      output.step(1);
      expect(output.position()).toBe(1);
      await output.play();
      await elapse(10);
      output.step(1);
      const stepped = output.position();
      expect(output.getSnapshot().state).toBe("paused");
      await elapse(10);
      expect(output.position()).toBe(stepped);
      output.seek(30);
      output.step(1);
      expect(output.position()).toBe(30);
      output.step(-1);
      expect(output.position()).toBe(28);
      await output.destroy();
    });

    it("resizes while playing, and refuses a size it can't draw, keeping the canvas", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      await output.play();
      output.resize(320, 40, 2);
      const passed = await elapse(10);
      expect(output.getSnapshot().state).toBe("playing");
      near(output.position(), Math.min(passed, 90));
      expect(() => output.resize(0, 40)).toThrow(TypeError);
      expect(() => output.resize(320, 40, Number.NaN)).toThrow(TypeError);
      // 20,000 × 20,000 is far over the default maxFramePixels.
      let error: unknown;
      try {
        output.resize(5_000, 5_000, 4);
      } catch (caught) {
        error = caught;
      }
      expect(isVideoError(error, "FRAME_TOO_LARGE")).toBe(true);
      expect(output.getSnapshot().state).toBe("playing");
      await output.destroy();
    });

    it("seeks within the plan, and keeps playing from there", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      output.seek(-5);
      expect(output.position()).toBe(0);
      output.seek(1_000);
      expect(output.position()).toBe(90);
      output.seek(10);
      await output.play();
      output.seek(60);
      // Playing resumes from the seek once its frame is drawn, which a
      // loaded runner delays: measure the clock from then, at its own rate.
      const from = await resumedAfter(output, 60, elapse);
      expect(from).toBeGreaterThanOrEqual(60);
      const passed = await elapse(6);
      near(output.position(), Math.min(from + passed, 90));
      expect(output.getSnapshot().state).toBe("playing");
      await output.destroy();
    });

    it("keeps playing from the playhead when the plan changes, clamping it to a shorter plan", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      output.seek(80);
      output.load(planOf(clipOf("x", source, 0, 40)));
      expect(output.position()).toBe(40);
      output.seek(10);
      await output.play();
      const at = output.position();
      output.load(planOf(clipOf("x", source, 0, 20), clipOf("y", source, 0, 20)));
      // It goes on from the playhead, at the clock's own rate.
      const from = await resumedAfter(output, at, elapse);
      expect(from).toBeGreaterThanOrEqual(at);
      const passed = await elapse(10);
      near(output.position(), Math.min(from + passed, 40));
      expect(output.getSnapshot().state).toBe("playing");
      await output.destroy();
    });

    it("stops back to the start, and doesn't play an empty plan", async () => {
      const { output, source, elapse } = await harness.create();
      output.load(planOf(clipOf("x", source, 0, 90)));
      await output.play();
      await elapse(30);
      output.stop();
      expect(output.getSnapshot().state).toBe("stopped");
      expect(output.position()).toBe(0);
      output.load(planOf());
      await output.play();
      expect(output.getSnapshot().state).toBe("stopped");
      await output.destroy();
    });

    it("throws on calls after destroy", async () => {
      const { output } = await harness.create();
      await output.destroy();
      expect(() => output.load(planOf())).toThrow();
      await expect(output.play()).rejects.toThrow();
    });
  });
}
