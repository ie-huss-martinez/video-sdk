import { createWindowReader } from "@hussmartinez/sdk-core";
import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import { checkEbml, looksEbml } from "./ebml.js";
import { refused } from "./errors.js";
import { checkIsobmff, looksIsobmff } from "./isobmff.js";
import type { FrontCheck } from "./types.js";

export type { FrontCheck } from "./types.js";

/**
 * The most packets a video track and an audio track may have under the
 * policy: the duration limit times the frame-rate limit, and times 1,000 a
 * second for audio (ADR 0004). The packet walk stops past them.
 *
 * @internal
 */
export function packetCaps(policy: VideoFilePolicy): {
  readonly video: number;
  readonly audio: number;
} {
  const seconds = policy.limits.maxDuration.maximum / 1_000;
  return {
    video: Math.ceil(seconds * policy.limits.maxFrameRate.maximum),
    audio: Math.ceil(seconds * 1_000),
  };
}

/**
 * Identifies a file by its signature, and walks its structure with the
 * SDK's own code before anything else reads it (ADR 0001): only ISOBMFF,
 * QuickTime, Matroska and WebM pass, with a bounded index, supported edit
 * lists and no encryption. The walk visits at most as many elements as the
 * limits allow packets, plus a margin for the structure around them.
 *
 * Throws `VideoError`: `UNSUPPORTED_FORMAT` for anything else or refused,
 * `INVALID_VIDEO` for malformed structure, and `INDEX_TOO_LARGE`.
 *
 * @internal
 */
export async function frontCheck(file: Blob, policy: VideoFilePolicy): Promise<FrontCheck> {
  const reader = createWindowReader(file);
  const caps = packetCaps(policy);
  const maxElements = caps.video + caps.audio + 10_000;
  if (await looksIsobmff(reader)) return checkIsobmff(reader, policy, maxElements);
  if (await looksEbml(reader)) return checkEbml(reader, policy, maxElements);
  throw refused("unknown", "signature");
}
