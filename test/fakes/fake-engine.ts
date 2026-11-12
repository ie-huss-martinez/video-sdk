import { throwIfAborted } from "../../src/core/errors/error-helpers.js";
import {
  frameTime,
  isFrameRate,
  sourceInfo,
  type VideoEngine,
  VideoError,
  type VideoProbe,
  type VideoSourceInfo,
  videoLimits,
} from "../../src/index.js";
import { decodeFakeVideo } from "./fake-video.js";

/** An engine fake that reads fake video files, and the sources it has open. */
export interface FakeEngine extends VideoEngine {
  readonly sources: ReadonlyMap<string, VideoSourceInfo>;
}

/** A reading fake: the real engine's checks and lifecycle, over fake files. */
export function createFakeEngine(): FakeEngine {
  const sources = new Map<string, VideoSourceInfo>();
  let destroyed = false;
  const assertAlive = () => {
    if (destroyed) throw new Error("The engine has been destroyed.");
  };

  return {
    sources,
    async probe(file, options) {
      assertAlive();
      throwIfAborted(options?.signal);
      let spec: Awaited<ReturnType<typeof decodeFakeVideo>>;
      try {
        spec = await decodeFakeVideo(file);
      } catch (cause) {
        throw new VideoError("INVALID_VIDEO", "The fake video's description is malformed.", {
          details: { container: "fake" },
          cause,
        });
      }
      if (spec === undefined) {
        throw new VideoError("UNSUPPORTED_FORMAT", "Not a fake video.", {
          details: { reason: "signature" },
        });
      }
      if (
        !isFrameRate(spec.rate) ||
        !(spec.frames >= 1) ||
        !(spec.width >= 1) ||
        !(spec.height >= 1)
      ) {
        throw new VideoError("INVALID_VIDEO", "The fake video's tracks are malformed.");
      }
      throwIfAborted(options?.signal);
      const policy = options?.filePolicy ?? videoLimits.resolve();
      policy.check("maxFileSize", file.size);
      policy.check("maxIndexSize", 64 * spec.frames);
      const walked = frameTime(spec.frames, spec.rate);
      const declared = frameTime(spec.declaredFrames ?? spec.frames, spec.rate);
      const probe: VideoProbe = {
        container: spec.container ?? "mp4",
        duration: Math.max(walked, declared),
        tracks: spec.tracks ?? (spec.audio ? 2 : 1),
        indexSize: 64 * spec.frames,
        peakBitrate: 1_000_000,
        maxPacketSize: 10_000,
        video: {
          codec: "avc1.64001f",
          codedWidth: spec.width + (spec.width % 16 === 0 ? 0 : 16 - (spec.width % 16)),
          codedHeight: spec.height + (spec.height % 16 === 0 ? 0 : 16 - (spec.height % 16)),
          displayWidth: spec.width,
          displayHeight: spec.height,
          rotation: spec.rotation ?? 0,
          frameRate: spec.rate.num / spec.rate.den,
          packets: spec.frames,
        },
        audio: spec.audio ? { codec: "mp4a.40.2", ...spec.audio } : null,
      };
      return probe;
    },
    async open(id, _file, probe, options) {
      assertAlive();
      throwIfAborted(options?.signal);
      if (sources.has(id)) throw new TypeError(`The source "${id}" is already open.`);
      const info = sourceInfo(id, probe);
      sources.set(id, info);
      return info;
    },
    async close(id) {
      assertAlive();
      sources.delete(id);
    },
    async destroy() {
      destroyed = true;
      sources.clear();
    },
  };
}
