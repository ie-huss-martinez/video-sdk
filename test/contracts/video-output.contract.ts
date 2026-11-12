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
    elapse(frames: number): Promise<void>;
  }>;
  /** How far the playhead may be from where it's expected, in frames. 0 for a manual clock. */
  readonly positionTolerance: number;
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
      expect(output.getSnapshot()).toEqual({ state: "stopped", droppedFrames: 0, error: null });
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
      await elapse(30);
      expect(states).toEqual(["playing"]);
      near(output.position(), 30);
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
      await elapse(15);
      near(output.position(), paused + 15);
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
      await elapse(5);
      near(output.position(), 5);
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
      await elapse(10);
      expect(output.getSnapshot().state).toBe("playing");
      near(output.position(), 10);
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
      await elapse(6);
      near(output.position(), 66);
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
      output.load(planOf(clipOf("x", source, 0, 20), clipOf("y", source, 0, 20)));
      await elapse(10);
      near(output.position(), 20);
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
