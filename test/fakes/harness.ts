import type { VideoEngineHarness } from "../contracts/video-engine.contract.js";
import type { VideoOutputHarness } from "../contracts/video-output.contract.js";
import type { VideoProcessorHarness } from "../contracts/video-processor.contract.js";
import { createFakeEngine } from "./fake-engine.js";
import { createFakeOutput } from "./fake-output.js";
import { createFakeProcessor } from "./fake-processor.js";
import { decodeFakeExport, encodeFakeVideo, type FakeVideoSpec } from "./fake-video.js";

const LANDSCAPE: FakeVideoSpec = {
  width: 1280,
  height: 720,
  rate: { num: 30, den: 1 },
  frames: 60,
  audio: { sampleRate: 48_000, channels: 2 },
};

export const fakeEngineHarness: VideoEngineHarness = {
  createEngine: createFakeEngine,
  landscape: async () => encodeFakeVideo(LANDSCAPE),
  rotated: async () => encodeFakeVideo({ ...LANDSCAPE, rotation: 90 }),
  undecodable: async () => encodeFakeVideo({ ...LANDSCAPE, codec: "hvc1.1.6.L93.B0" }),
  silent: async () => encodeFakeVideo({ ...LANDSCAPE, audio: null }),
  lyingHeader: async () => encodeFakeVideo({ ...LANDSCAPE, declaredFrames: 30 }),
  malformed: async () => new Blob(["FAKEVIDEO1\n{not json"]),
  unknown: async () => new Blob(["RIFF nothing we know"]),
  tolerance: { frameRate: 0, duration: 0 },
};

/** A fake engine with two open fake sources, `a` and `b`. */
async function openTwo(seconds: number) {
  const engine = createFakeEngine();
  const open = async (id: string) => {
    const file = encodeFakeVideo({ ...LANDSCAPE, frames: 30 * seconds });
    return engine.open(id, file, await engine.probe(file));
  };
  return { engine, a: await open("a"), b: await open("b") };
}

export const fakeProcessorHarness: VideoProcessorHarness = {
  async setup() {
    const { engine, a, b } = await openTwo(4);
    return {
      processor: createFakeProcessor(engine.sources),
      a,
      b,
      teardown: () => engine.destroy(),
    };
  },
  inspect: decodeFakeExport,
  timeTolerance: 0,
};

export const fakeOutputHarness: VideoOutputHarness = {
  async create() {
    const { a } = await openTwo(4);
    const { output, clock } = createFakeOutput();
    return {
      output,
      source: a,
      elapse: async (frames) => {
        await clock.advance(frames);
        return frames;
      },
    };
  },
  positionTolerance: 0,
};
