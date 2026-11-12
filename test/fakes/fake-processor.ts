import { throwIfAborted } from "../../src/core/errors/error-helpers.js";
import {
  locateFrame,
  planFrames,
  type VideoClip,
  VideoError,
  type VideoProcessor,
  type VideoSourceInfo,
} from "../../src/index.js";
import { encodeFakeExport } from "./fake-video.js";

/** Frames between progress reports and yields to the event loop. */
const BATCH = 8;

/**
 * An export fake over the sources a fake engine has open: it writes which
 * source frame every output frame shows, and the plan's metadata, so tests
 * can check an export holds exactly the plan's frames.
 */
export function createFakeProcessor(sources: ReadonlyMap<string, VideoSourceInfo>): VideoProcessor {
  let busy = false;
  let destroyed = false;

  return {
    async export(job, options) {
      if (destroyed) throw new Error("The processor has been destroyed.");
      if (busy) throw new VideoError("BUSY", "Another export is running.");
      throwIfAborted(options?.signal);
      const missing = job.plan.clips.find((clip: VideoClip) => !sources.has(clip.source));
      if (missing) throw new TypeError(`The source "${missing.source}" isn't open.`);
      busy = true;
      try {
        const total = planFrames(job.plan);
        const frames: { source: string; time: number }[] = [];
        for (let frame = 0; frame < total; frame += 1) {
          if (frame % BATCH === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            throwIfAborted(options?.signal);
            if (destroyed) throw new VideoError("ABORTED", "The processor was destroyed.");
            options?.onProgress?.(frame / total);
          }
          const at = locateFrame(job.plan, frame);
          const clip = at && job.plan.clips[at.index];
          if (at && clip) frames.push({ source: clip.source, time: at.sourceTime });
        }
        const metadata = Object.fromEntries(
          Object.entries(job.plan.metadata).filter(([, value]) => value !== ""),
        );
        const file = encodeFakeExport({ container: job.container ?? "mp4", frames, metadata });
        options?.onProgress?.(1);
        return file;
      } finally {
        busy = false;
      }
    },
    async destroy() {
      destroyed = true;
    },
  };
}
