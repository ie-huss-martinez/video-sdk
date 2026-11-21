import { createWorkerClient, type WorkerLike } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { createEngine, createVideoEngine, engineInternals } from "../src/adapters/video-engine.js";
import { createVideoSession, isVideoError, VideoError, videoLimits } from "../src/index.js";
import { clipOf, planOf } from "./contracts/helpers.js";
import exportA from "./fixtures/video/export-a.webm?url";
import silentVp8 from "./fixtures/video/silent-vp8.webm?url";
import { DEV_WORKER_START_TIMEOUT } from "./support/load.js";
import type { InspectContract } from "./workers/inspect.worker.js";
import type { NoAudioCodecsContract } from "./workers/no-audio-codecs.worker.js";

// A browser without WebCodecs' audio decoder or encoder (docs/adr/0008):
// every engine in the test image has both, so these run the SDK's own
// worker code in a worker that has them removed. A file then opens with its
// picture and no sound, with a warning; and an export of sound fails with
// UNSUPPORTED_CODEC for the audio track, unless it's asked to leave the
// sound out.

const startWithoutAudio: () => WorkerLike = () =>
  new Worker(new URL("./workers/no-audio-codecs.worker.ts", import.meta.url), { type: "module" });
const withoutAudio = createWorkerClient<NoAudioCodecsContract>({
  createWorker: startWithoutAudio,
  errorClasses: { VideoError },
});
const inspector = createWorkerClient<InspectContract>({
  createWorker: () =>
    new Worker(new URL("./workers/inspect.worker.ts", import.meta.url), { type: "module" }),
});
const blob = async (url: string) => (await fetch(url)).blob();
const limits = videoLimits.resolve().limits;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

/** A plan at a small size, so the export is quick. */
function smallPlan(...clips: Parameters<typeof planOf>) {
  const plan = planOf(...clips);
  return { ...plan, output: { ...plan.output, width: 256, height: 32 } };
}

describe("a browser without an audio decoder", () => {
  it("opens a file with sound as picture only, names the codec, and the session warns", async () => {
    const engine = createEngine({
      loadWorker: async () => startWithoutAudio,
      startTimeout: DEV_WORKER_START_TIMEOUT,
    });
    try {
      const file = await blob(exportA);
      const probe = await engine.probe(file);
      expect(probe.audio).not.toBeNull();
      const info = await engine.open("a", file, probe);
      expect(info.audio).toBeNull();
      expect(info.unplayableAudio).toEqual({ codec: probe.audio?.codec });
      // No sound to draw or play: no peaks.
      expect(await engine.peaks("a")).toBeNull();
      await engine.close("a");

      const session = createVideoSession({ engine });
      const inserted = await session.insert(file);
      expect(session.getSnapshot().warnings).toContainEqual({
        type: "audioUndecodable",
        source: inserted.id,
        codec: probe.audio?.codec,
      });
      // The output it set up has a sound layout of its own, as for a silent file.
      expect(session.getSnapshot().plan?.output).toMatchObject({ sampleRate: 48_000, channels: 2 });
      await session.destroy();
    } finally {
      await engine.destroy();
    }
  });
});

describe("a browser without an audio encoder", () => {
  /** A real engine's open source, which the export worker reads. */
  async function opened(url: string) {
    const engine = createVideoEngine({ startTimeout: DEV_WORKER_START_TIMEOUT });
    const file = await blob(url);
    const info = await engine.open("s", file, await engine.probe(file));
    const source = engineInternals(engine)?.source("s");
    if (!source) throw new Error("expected the source to be open");
    return { engine, info, source };
  }

  it("refuses to export sound, naming the audio track, and never drops it silently", async () => {
    const { engine, info, source } = await opened(exportA);
    try {
      const error = await failure(
        withoutAudio.call("export", {
          plan: smallPlan(clipOf("x", info, 0, 15)),
          sources: [source],
          limits,
        }),
      );
      expect(isVideoError(error, "UNSUPPORTED_CODEC")).toBe(true);
      expect((error as VideoError).details).toEqual({ codec: "AudioEncoder", track: "audio" });
    } finally {
      await engine.destroy();
    }
  });

  it("exports the picture only when asked to leave the sound out", async () => {
    const { engine, info, source } = await opened(exportA);
    try {
      const { file } = await withoutAudio.call("export", {
        plan: smallPlan(clipOf("x", info, 0, 15)),
        sources: [source],
        limits,
        audio: "omit",
      });
      const read = await inspector.call("inspect", file);
      expect(read.audioCodec).toBeNull();
      expect(read.numbers).toHaveLength(15);
    } finally {
      await engine.destroy();
    }
  });

  it("exports a plan without sound as before: no audio encoder is needed for it", async () => {
    const { engine, info, source } = await opened(silentVp8);
    try {
      expect(info.audio).toBeNull();
      const { file } = await withoutAudio.call("export", {
        plan: smallPlan(clipOf("x", info, 0, 15)),
        sources: [source],
        limits,
      });
      expect((await inspector.call("inspect", file)).audioCodec).toBeNull();
    } finally {
      await engine.destroy();
    }
  });
});
