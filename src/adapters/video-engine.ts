import {
  createWorkerClient,
  type WorkerClient,
  type WorkerLike,
  withProcessingTime,
} from "@hussmartinez/sdk-core";
import { asVideoError, throwIfAborted } from "../core/errors/error-helpers.js";
import { VideoError } from "../core/errors/video-error.js";
import { type VideoFilePolicy, videoLimits } from "../core/errors/video-limits.js";
import { sourceInfo, type VideoProbe } from "../core/model/source.js";
import type { VideoEngine } from "../core/ports/video-engine.js";
import type { MediaWorkerContract } from "./media-worker/contract.js";

/**
 * Options for {@link createVideoEngine}.
 *
 * @public
 */
export interface VideoEngineOptions {
  /**
   * Milliseconds without calls after which the media worker stops. It starts
   * again on the next call. Defaults to sdk-core's 30 seconds.
   */
  readonly idleTimeout?: number;
}

/**
 * What the engine needs from its environment, replaceable in tests.
 *
 * @internal
 */
export interface EngineEnvironment {
  /** Loads the worker's code, on the first call, and returns how to start it. */
  readonly loadWorker: () => Promise<() => WorkerLike>;
  readonly idleTimeout?: number;
}

/**
 * Creates the SDK's video engine (docs/adr/0001, docs/adr/0002). It probes
 * MP4, QuickTime, WebM and Matroska files in its media worker: the SDK's own
 * front check bounds the index and refuses edit lists and encryption it
 * doesn't support, then mediabunny walks every packet, without decoding
 * anything. `probe` applies `maxFileSize`, `maxIndexSize` and the packet
 * walk's caps from the `filePolicy` you pass; check the result against the
 * other limits with `checkProbe` before opening it.
 *
 * Nothing starts until the first call. The worker is inlined, which needs
 * `worker-src blob:` in a Content Security Policy, and it makes no requests of
 * its own.
 *
 * @example
 * ```ts
 * const engine = createVideoEngine();
 * const policy = videoLimits.resolve(props.filePolicy);
 * const probe = await engine.probe(file, { filePolicy: policy });
 * checkProbe(policy, probe);
 * const source = await engine.open("clip-1", file, probe);
 * ```
 *
 * @public
 */
export function createVideoEngine(options: VideoEngineOptions = {}): VideoEngine {
  return createEngine({
    loadWorker: async () => (await import("./media-worker/inline-worker.js")).createInlineWorker,
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
  });
}

/** Whether two probes describe the same file. */
function sameFile(a: VideoProbe, b: VideoProbe): boolean {
  return (
    a.container === b.container &&
    a.duration === b.duration &&
    a.video.codec === b.video.codec &&
    a.video.codedWidth === b.video.codedWidth &&
    a.video.codedHeight === b.video.codedHeight &&
    a.video.packets === b.video.packets &&
    a.audio?.codec === b.audio?.codec
  );
}

/**
 * The engine, with its environment passed in.
 *
 * @internal
 */
export function createEngine(environment: EngineEnvironment): VideoEngine {
  let startWorker: (() => WorkerLike) | undefined;
  let client: WorkerClient<MediaWorkerContract> | undefined;
  let destroyed = false;
  /** Probes this engine made, which `open` can trust without probing again. */
  const trusted = new WeakSet<VideoProbe>();
  const sources = new Map<string, { readonly file: Blob; readonly probe: VideoProbe }>();

  const assertAlive = () => {
    if (destroyed) throw new Error("The video engine has been destroyed.");
  };

  async function worker(): Promise<WorkerClient<MediaWorkerContract>> {
    startWorker ??= await environment.loadWorker();
    client ??= createWorkerClient<MediaWorkerContract>({
      createWorker: () => {
        if (!startWorker)
          throw new VideoError("WORKER_START_FAILED", "The media worker hasn't loaded.");
        return startWorker();
      },
      errorClasses: { VideoError },
      ...(environment.idleTimeout === undefined ? {} : { idleTimeout: environment.idleTimeout }),
    });
    return client;
  }

  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof TypeError ? error : asVideoError(error);
    }
  }

  async function probe(
    file: Blob,
    policy: VideoFilePolicy,
    signal?: AbortSignal,
  ): Promise<VideoProbe> {
    const media = await worker();
    const probed = await withProcessingTime(
      policy,
      (timed) => media.call("probe", { file, limits: policy.limits }, { signal: timed }),
      signal ? { signal } : {},
    );
    trusted.add(probed);
    return probed;
  }

  return {
    probe(file, options = {}) {
      return run(async () => {
        assertAlive();
        throwIfAborted(options.signal);
        return probe(file, options.filePolicy ?? videoLimits.resolve(), options.signal);
      });
    },
    open(id, file, given, options = {}) {
      return run(async () => {
        assertAlive();
        throwIfAborted(options.signal);
        if (sources.has(id)) throw new TypeError(`The source "${id}" is already open.`);
        // A probe the caller rebuilt or copied: probe the file again, and
        // make sure it describes the same file, so that limits were checked
        // against what the file really holds.
        if (!trusted.has(given)) {
          const fresh = await probe(file, videoLimits.resolve(), options.signal);
          if (!sameFile(fresh, given)) {
            throw new VideoError("INVALID_VIDEO", "The probe doesn't describe this file.", {
              details: { container: given.container, reason: "probe" },
            });
          }
        }
        throwIfAborted(options.signal);
        if (sources.has(id)) throw new TypeError(`The source "${id}" is already open.`);
        sources.set(id, { file, probe: given });
        return sourceInfo(id, given);
      });
    },
    async close(id) {
      assertAlive();
      sources.delete(id);
    },
    async destroy() {
      destroyed = true;
      sources.clear();
      client?.destroy();
    },
  };
}
