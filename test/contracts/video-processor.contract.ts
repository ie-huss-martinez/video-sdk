import { describe, expect, it } from "vitest";
import {
  isVideoError,
  locateFrame,
  planFrames,
  type VideoPlan,
  type VideoProcessor,
  type VideoSourceInfo,
} from "../../src/index.js";
import { aborted, clipOf, planOf, rejection } from "./helpers.js";

/** Where each frame of an exported file came from, and the metadata it carries. */
export interface InspectedExport {
  readonly frames: readonly { readonly source: string; readonly time: number }[];
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * What a processor's contract test needs: a processor with two open
 * sources, and a way to read back what an export contains. The SDK's adapter
 * opens generated files whose every frame shows its own number, and decodes
 * the export to read them; the fakes record it directly.
 */
export interface VideoProcessorHarness {
  /** A processor, and two open sources, each at least 2 seconds of 30 fps video with audio. */
  setup(): Promise<{
    readonly processor: VideoProcessor;
    readonly a: VideoSourceInfo;
    readonly b: VideoSourceInfo;
    teardown(): Promise<void>;
  }>;
  inspect(file: Blob): Promise<InspectedExport>;
  /** How far an exported frame's source time may be from the plan's, in microseconds. */
  readonly timeTolerance: number;
}

function expected(plan: VideoPlan): { source: string; time: number }[] {
  return Array.from({ length: planFrames(plan) }, (_, frame) => {
    const at = locateFrame(plan, frame);
    const clip = at && plan.clips[at.index];
    if (!at || !clip) throw new Error("frame outside the plan");
    return { source: clip.source, time: at.sourceTime };
  });
}

/**
 * The behaviour every {@link VideoProcessor} must have (ADR 0001, ADR 0003,
 * ADR 0005, ADR 0008). Adapters run it with their own harness.
 */
export function describeVideoProcessorContract(name: string, harness: VideoProcessorHarness): void {
  describe(`${name}: the VideoProcessor contract`, () => {
    it("exports exactly the plan's frames, in order, and nothing that was cut", async () => {
      const { processor, a, b, teardown } = await harness.setup();
      // Pieces of two sources, cut and reordered: whatever lies outside them was cut.
      const plan = planOf(
        clipOf("x", a, 500_000, 15),
        clipOf("y", b, 0, 9),
        clipOf("z", a, 1_500_000, 3),
      );
      const { frames } = await harness.inspect(await processor.export({ plan }));
      const want = expected(plan);
      expect(frames).toHaveLength(want.length);
      for (const [index, frame] of frames.entries()) {
        expect(frame.source, `frame ${index}`).toBe(want[index]?.source);
        expect(
          Math.abs(frame.time - (want[index]?.time ?? Number.NaN)),
          `frame ${index}`,
        ).toBeLessThanOrEqual(harness.timeTolerance);
      }
      await teardown();
    });

    it("writes only the metadata the plan sets", async () => {
      const { processor, a, teardown } = await harness.setup();
      const plan: VideoPlan = {
        ...planOf(clipOf("x", a, 0, 10)),
        metadata: { title: "Harbour", description: "", artist: "Ana", date: "", comment: "" },
      };
      const { metadata } = await harness.inspect(await processor.export({ plan }));
      expect(metadata).toEqual({ title: "Harbour", artist: "Ana" });
      await teardown();
    });

    it("reports progress that only moves forward and ends at 1", async () => {
      const { processor, a, teardown } = await harness.setup();
      const progress: number[] = [];
      await processor.export(
        { plan: planOf(clipOf("x", a, 0, 40)) },
        { onProgress: (fraction) => progress.push(fraction) },
      );
      expect(progress.at(-1)).toBe(1);
      expect(progress).toEqual([...progress].sort((x, y) => x - y));
      await teardown();
    });

    it("runs one export at a time, rejecting another with BUSY", async () => {
      const { processor, a, teardown } = await harness.setup();
      const plan = planOf(clipOf("x", a, 0, 40));
      const first = processor.export({ plan });
      expect(isVideoError(await rejection(processor.export({ plan })), "BUSY")).toBe(true);
      await expect(first).resolves.toBeInstanceOf(Blob);
      await expect(processor.export({ plan })).resolves.toBeInstanceOf(Blob);
      await teardown();
    });

    it("rejects a cancelled export with ABORTED, before it starts or partway through", async () => {
      const { processor, a, teardown } = await harness.setup();
      const plan = planOf(clipOf("x", a, 0, 60));
      expect(
        isVideoError(await rejection(processor.export({ plan }, { signal: aborted() })), "ABORTED"),
      ).toBe(true);
      const controller = new AbortController();
      const running = processor.export(
        { plan },
        { signal: controller.signal, onProgress: (fraction) => fraction > 0 && controller.abort() },
      );
      expect(isVideoError(await rejection(running), "ABORTED")).toBe(true);
      await expect(processor.export({ plan })).resolves.toBeInstanceOf(Blob);
      await teardown();
    });

    it("rejects a clip whose source isn't open with TypeError", async () => {
      const { processor, a, teardown } = await harness.setup();
      const plan = planOf({ ...clipOf("x", a, 0, 10), source: "not-open" });
      expect(await rejection(processor.export({ plan }))).toBeInstanceOf(TypeError);
      await teardown();
    });

    it("rejects calls after destroy", async () => {
      const { processor, a, teardown } = await harness.setup();
      await processor.destroy();
      await expect(processor.export({ plan: planOf(clipOf("x", a, 0, 10)) })).rejects.toThrow();
      await teardown();
    });
  });
}
