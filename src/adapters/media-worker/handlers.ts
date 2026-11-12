import type { WorkerHandlers } from "@hussmartinez/sdk-core";
import { videoLimits } from "../../core/errors/video-limits.js";
import { frontCheck } from "../front-check/front-check.js";
import { checkDecoderSupport } from "../mediabunny/decoder-support.js";
import { probeFile } from "../probe.js";
import type { MediaWorkerContract } from "./contract.js";

/**
 * The media worker's handlers (docs/adr/0002), apart from how they're
 * exposed, so that tests can expose them in a worker with guarded globals.
 */
export function mediaWorkerHandlers(): WorkerHandlers<MediaWorkerContract> {
  return {
    probe: ({ file, limits }, { signal }) => probeFile(file, videoLimits.resolve(limits), signal),
    async support({ file, limits, probe }, { signal }) {
      // The same front check as a probe, before mediabunny reads the file.
      await frontCheck(file, videoLimits.resolve(limits));
      await checkDecoderSupport(file, probe, signal);
      return undefined;
    },
  };
}
