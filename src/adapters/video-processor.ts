import { resolveAssetsBase, type WorkerLike } from "@hussmartinez/sdk-core";
import { throwIfAborted } from "../core/errors/error-helpers.js";
import { VideoError } from "../core/errors/video-error.js";
import { type VideoFilePolicy, videoLimits } from "../core/errors/video-limits.js";
import type { VideoEngine } from "../core/ports/video-engine.js";
import type { VideoProcessor } from "../core/ports/video-processor.js";
import type { ExportRunner } from "./export-worker/runner.js";
import type { PlaybackSource } from "./media-worker/contract.js";
import { engineInternals, selfHostedWorker } from "./video-engine.js";

/**
 * Options for {@link createVideoProcessor}.
 *
 * @public
 */
export interface VideoProcessorOptions {
  /** The engine whose open sources exports read: one made by `createVideoEngine`. */
  readonly engine: VideoEngine;
  /**
   * The limits an export runs under: it fails with `PROCESSING_TIME_EXCEEDED`
   * when no frame is encoded for `maxProcessingTime`, however long the whole
   * export takes, and each source is checked again before it's read. The
   * defaults of `videoLimits` when omitted.
   */
  readonly filePolicy?: VideoFilePolicy;
  /**
   * Where the application serves the package's `dist/assets/` directory, to
   * start the export worker from `video/export.worker.js` under it rather
   * than inlined (sdk-core ADR 0038), as for `createVideoEngine`.
   */
  readonly assetsUrl?: string | URL;
}

/** The self-hosted export worker, under `assetsUrl` (docs/adr/0002). */
const EXPORT_WORKER_ASSET = "video/export.worker.js";

/**
 * What the processor needs from its environment, replaceable in tests.
 *
 * @internal
 */
export interface ProcessorEnvironment {
  readonly source: (id: string) => PlaybackSource | undefined;
  /** Loads the export code and returns its runner, on the first export. */
  readonly loadRunner: () => Promise<ExportRunner>;
  readonly policy: VideoFilePolicy;
}

/**
 * Creates the SDK's export processor (docs/adr/0005). It exports plans over
 * the sources open in `engine` in an export worker of its own: every frame
 * is decoded, composed and encoded again, the audio is mixed and encoded on
 * the same timeline, and only the metadata the plan sets is written. The
 * container and codecs are chosen by what the browser can encode, proved by
 * encoding with them first (docs/adr/0001). Nothing loads until the first
 * export, and the worker stops after sdk-core's idle timeout.
 *
 * Throws `TypeError` for an engine `createVideoEngine` didn't make.
 *
 * @example
 * ```ts
 * const processor = createVideoProcessor({ engine });
 * const file = await processor.export({ plan }, { onProgress, signal });
 * ```
 *
 * @public
 */
export function createVideoProcessor(options: VideoProcessorOptions): VideoProcessor {
  const internals = engineInternals(options.engine);
  if (!internals) {
    throw new TypeError(
      "createVideoProcessor reads sources from an engine made by createVideoEngine.",
    );
  }
  // Resolved now, so a mistake fails when the processor is created.
  const base = options.assetsUrl === undefined ? undefined : resolveAssetsBase(options.assetsUrl);
  return createProcessor({
    source: internals.source,
    policy: options.filePolicy ?? videoLimits.resolve(),
    async loadRunner() {
      const { createExportRunner } = await import("./export-worker/runner.js");
      if (base) {
        return createExportRunner(
          selfHostedWorker(base, EXPORT_WORKER_ASSET, "hm-video-export"),
          EXPORT_WORKER_ASSET,
          internals.startTimeout,
        );
      }
      const { createInlineExportWorker } = await import("./export-worker/export-inline-worker.js");
      return createExportRunner(
        createInlineExportWorker as () => WorkerLike,
        undefined,
        internals.startTimeout,
      );
    },
  });
}

/**
 * The processor, with its environment passed in.
 *
 * @internal
 */
export function createProcessor(environment: ProcessorEnvironment): VideoProcessor {
  let busy = false;
  let destroyed = false;
  let runner: Promise<ExportRunner> | undefined;
  return {
    async export(job, options = {}) {
      if (destroyed) throw new Error("The video processor has been destroyed.");
      const sources = new Map<string, PlaybackSource>();
      for (const clip of job.plan.clips) {
        const source = environment.source(clip.source);
        if (!source) throw new TypeError(`The source "${clip.source}" isn't open in the engine.`);
        sources.set(clip.source, source);
      }
      if (busy) throw new VideoError("BUSY", "Another export is running.");
      throwIfAborted(options.signal);
      busy = true;
      try {
        runner ??= environment.loadRunner();
        return await (await runner).run(
          {
            plan: job.plan,
            sources: [...sources.values()],
            ...(job.container === undefined ? {} : { container: job.container }),
            ...(job.quality === undefined ? {} : { quality: job.quality }),
          },
          environment.policy,
          options,
        );
      } finally {
        busy = false;
      }
    },
    async destroy() {
      destroyed = true;
      (await runner)?.destroy();
    },
  };
}
