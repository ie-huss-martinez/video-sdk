import { throwIfAborted } from "../../src/core/errors/error-helpers.js";
import {
  frameTime,
  isFrameRate,
  sourceInfo,
  type VideoEngine,
  VideoError,
  type VideoProbe,
  type VideoProbeOptions,
  type VideoSourceInfo,
  videoLimits,
} from "../../src/index.js";
import { decodeFakeVideo } from "./fake-video.js";

/** The video codecs the fake engine "decodes": anything else is `UNSUPPORTED_CODEC`. */
const DECODABLE = ["avc1.", "vp8", "vp09."];

/** An engine fake that reads fake video files, and the sources it has open. */
export interface FakeEngine extends VideoEngine {
  readonly sources: ReadonlyMap<string, VideoSourceInfo>;
}

/** A reading fake: the real engine's checks and lifecycle, over fake files. */
export function createFakeEngine(): FakeEngine {
  const sources = new Map<string, VideoSourceInfo>();
  /** Probes this engine made, frozen, which `open` trusts for the Blob each was made from. */
  const trusted = new WeakMap<VideoProbe, Blob>();
  let destroyed = false;
  const assertAlive = () => {
    if (destroyed) throw new Error("The engine has been destroyed.");
  };

  async function probeFile(file: Blob, options?: VideoProbeOptions): Promise<VideoProbe> {
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
    const pad = (size: number) => size + (size % 16 === 0 ? 0 : 16 - (size % 16));
    const probe: VideoProbe = {
      container: spec.container ?? "mp4",
      start: 0,
      duration: Math.max(walked, declared),
      tracks: spec.tracks ?? (spec.audio ? 2 : 1),
      indexSize: 64 * spec.frames,
      peakBitrate: 1_000_000,
      maxPacketSize: 10_000,
      video: Object.freeze({
        codec: spec.codec ?? "avc1.64001f",
        codedWidth: pad(spec.width),
        codedHeight: pad(spec.height),
        displayWidth: spec.width,
        displayHeight: spec.height,
        rotation: spec.rotation ?? 0,
        frameRate: spec.rate.num / spec.rate.den,
        packets: spec.frames,
      }),
      audio: spec.audio ? Object.freeze({ codec: "mp4a.40.2", ...spec.audio }) : null,
    };
    trusted.set(Object.freeze(probe), file);
    return probe;
  }

  return {
    sources,
    probe: probeFile,
    async open(id, file, given, options) {
      assertAlive();
      throwIfAborted(options?.signal);
      if (sources.has(id)) throw new TypeError(`The source "${id}" is already open.`);
      let probe = given;
      if (trusted.get(given) !== file) {
        const fresh = await probeFile(file, options);
        if (JSON.stringify(fresh) !== JSON.stringify(given)) {
          throw new VideoError("INVALID_VIDEO", "The probe doesn't describe this file.");
        }
        probe = fresh;
      }
      if (!DECODABLE.some((prefix) => probe.video.codec.startsWith(prefix))) {
        throw new VideoError("UNSUPPORTED_CODEC", "This browser can't decode the video track.", {
          details: { codec: probe.video.codec, track: "video" },
        });
      }
      const info = sourceInfo(id, probe);
      sources.set(id, info);
      return info;
    },
    async peaks(id, options) {
      assertAlive();
      throwIfAborted(options?.signal);
      const source = sources.get(id);
      if (!source) throw new TypeError(`The source "${id}" isn't open.`);
      if (source.audio === null) return null;
      // A steady tone at an eighth of full scale, as the generated fixtures hold.
      const buckets = Math.ceil(source.duration / 10_000);
      return {
        bucketDuration: 10_000,
        min: new Float32Array(buckets).fill(-0.125),
        max: new Float32Array(buckets).fill(0.125),
      };
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
