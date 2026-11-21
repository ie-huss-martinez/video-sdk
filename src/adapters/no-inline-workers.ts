import { VideoError } from "../core/errors/video-error.js";

/**
 * What an application's build gets instead of the inlined workers when it
 * sets the `hm-self-hosted` resolve condition (sdk-core ADR 0060):
 * `#hm-video-media-worker` and `#hm-video-export-worker` both map here, so
 * neither inlined worker is bundled. Such a build must pass `assetsUrl` to
 * `createVideoEngine` and `createVideoProcessor`; without it, starting a
 * worker fails here, loudly, rather than with a bare error from the module
 * system.
 */
function leftOut(): VideoError {
  return new VideoError(
    "WORKER_START_FAILED",
    "This build left the video SDK's inlined workers out, with the hm-self-hosted condition, so assetsUrl is required.",
    { details: { condition: "hm-self-hosted", missing: "assetsUrl" } },
  );
}

/** Stands in for the inlined media worker. */
export function createInlineWorker(): Worker {
  throw leftOut();
}

/** Stands in for the inlined export worker. */
export function createInlineExportWorker(): Worker {
  throw leftOut();
}
