import { createWorkerClient, type WorkerClient, type WorkerLike } from "@hussmartinez/sdk-core";
import { asVideoError } from "../../core/errors/error-helpers.js";
import { VideoError } from "../../core/errors/video-error.js";
import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import type { VideoExportOptions } from "../../core/ports/video-processor.js";
import type { ExportWorkerContract } from "./contract.js";
import type { ExportRequest } from "./export-plan.js";

/**
 * Runs exports in the export worker (docs/adr/0002, docs/adr/0005), loaded
 * with the first export. The worker stops after sdk-core's idle timeout.
 *
 * @internal
 */
export interface ExportRunner {
  run(
    request: Omit<ExportRequest, "limits">,
    policy: VideoFilePolicy,
    options: VideoExportOptions,
  ): Promise<Blob>;
  destroy(): void;
}

/**
 * An abort signal that fires `PROCESSING_TIME_EXCEEDED` when no progress is
 * reported for `maxProcessingTime` (docs/adr/0005): an export stalls on no
 * single frame that long, however long the whole export takes.
 */
function stallSignal(policy: VideoFilePolicy, signal: AbortSignal | undefined) {
  const controller = new AbortController();
  const maximum = policy.limits.maxProcessingTime.maximum;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(
        new VideoError("PROCESSING_TIME_EXCEEDED", "The export stopped making progress.", {
          details: {
            limit: "maxProcessingTime",
            maximum,
            actual: maximum,
            unit: "milliseconds",
          },
        }),
      );
    }, maximum);
  };
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    progressed: arm,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Creates the export runner, given how to start the worker.
 *
 * @internal
 */
export function createExportRunner(startWorker: () => WorkerLike): ExportRunner {
  let client: WorkerClient<ExportWorkerContract> | undefined;
  return {
    async run(request, policy, options) {
      client ??= createWorkerClient<ExportWorkerContract>({
        createWorker: startWorker,
        errorClasses: { VideoError },
      });
      const stall = stallSignal(policy, options.signal);
      try {
        return await client.call(
          "export",
          { ...request, limits: policy.limits },
          {
            signal: stall.signal,
            onProgress: (update) => {
              if (typeof update === "number") {
                stall.progressed();
                options.onProgress?.(update);
              } else {
                options.onWarning?.(update.warning);
              }
            },
          },
        );
      } catch (error) {
        throw error instanceof TypeError ? error : asVideoError(error);
      } finally {
        stall.dispose();
      }
    },
    destroy() {
      client?.destroy();
    },
  };
}
