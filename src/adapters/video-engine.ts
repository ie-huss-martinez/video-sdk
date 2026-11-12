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

/**
 * Whether two probes are the same, field by field. A probe is plain data:
 * numbers, strings, `null` and objects of them.
 */
function sameProbe(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameProbe((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Freezes a probe and everything in it, so that a trusted probe can't change. */
function freeze(probe: VideoProbe): VideoProbe {
  Object.freeze(probe.video);
  if (probe.audio) Object.freeze(probe.audio);
  return Object.freeze(probe);
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
  const trusted = new WeakMap<VideoProbe, Blob>();
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
    // Frozen before it's trusted: a caller can't lower a value in it to pass
    // the limits, then open the file with it.
    // A probe is trusted only for the Blob it was made from.
    trusted.set(freeze(probed), file);
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
        // A probe the caller rebuilt or copied, such as one restored from a
        // saved session, or a probe of another file: probe this file again,
        // under the caller's policy, and open it with the fresh probe only if
        // every field matches, so that limits were checked against what the
        // file really holds.
        const policy = options.filePolicy ?? videoLimits.resolve();
        let opened = given;
        if (trusted.get(given) !== file) {
          const fresh = await probe(file, policy, options.signal);
          if (!sameProbe(fresh, given)) {
            throw new VideoError("INVALID_VIDEO", "The probe doesn't describe this file.", {
              details: { container: fresh.container, reason: "probe" },
            });
          }
          opened = fresh;
        }
        // Only a file this browser can decode opens (docs/adr/0001). The
        // worker checks the file again before mediabunny reads it, under the
        // same policy and processing time as a probe.
        const media = await worker();
        await withProcessingTime(
          policy,
          (timed) =>
            media.call(
              "support",
              { file, limits: policy.limits, probe: opened },
              { signal: timed },
            ),
          options.signal ? { signal: options.signal } : {},
        );
        throwIfAborted(options.signal);
        if (sources.has(id)) throw new TypeError(`The source "${id}" is already open.`);
        sources.set(id, { file, probe: opened });
        return sourceInfo(id, opened);
      });
    },
    peaks(id, options = {}) {
      return run(async () => {
        assertAlive();
        throwIfAborted(options.signal);
        const source = sources.get(id);
        if (!source) throw new TypeError(`The source "${id}" isn't open.`);
        const policy = options.filePolicy ?? videoLimits.resolve();
        const media = await worker();
        return withProcessingTime(
          policy,
          (timed) =>
            media.call(
              "peaks",
              { file: source.file, limits: policy.limits, probe: source.probe },
              { signal: timed },
            ),
          options.signal ? { signal: options.signal } : {},
        );
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
