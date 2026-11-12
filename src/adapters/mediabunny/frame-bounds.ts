import type { VideoProbe } from "../../core/model/source.js";
import type { FrameBounds } from "./video-decoder.js";

/**
 * What every decoded frame of a probed file must stay within (docs/adr/0001):
 * the probe's coded size, and timestamps from the probe's start to the end of
 * its duration.
 *
 * @internal
 */
export function frameBounds(probe: VideoProbe): FrameBounds {
  return {
    codedWidth: probe.video.codedWidth,
    codedHeight: probe.video.codedHeight,
    firstTimestamp: probe.start,
    lastTimestamp: probe.start + probe.duration,
  };
}
