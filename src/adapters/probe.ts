import { checkFile } from "@hussmartinez/sdk-core";
import { throwIfAborted } from "../core/errors/error-helpers.js";
import type { VideoFilePolicy } from "../core/errors/video-limits.js";
import type { VideoProbe } from "../core/model/source.js";
import { frontCheck } from "./front-check/front-check.js";
import { walkPackets } from "./mediabunny/packet-walk.js";

/**
 * Probes a file without decoding it (ADR 0001): its size against
 * `maxFileSize`, the SDK's own front check, which bounds the index before
 * anything else reads the file, then mediabunny's packet walk. The result is
 * checked against the other limits by `checkProbe`, before any decoder is
 * configured.
 *
 * @internal
 */
export async function probeFile(
  file: Blob,
  policy: VideoFilePolicy,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  throwIfAborted(signal);
  checkFile(policy, file);
  const front = await frontCheck(file, policy);
  throwIfAborted(signal);
  const walk = await walkPackets(file, front, policy, signal);
  return {
    container: front.container,
    duration: walk.duration,
    tracks: front.tracks,
    indexSize: front.indexSize,
    peakBitrate: walk.peakBitrate,
    maxPacketSize: walk.maxPacketSize,
    video: walk.video,
    audio: walk.audio,
  };
}
