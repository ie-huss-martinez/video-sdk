import type { InputVideoTrack } from "mediabunny";
import type { VideoProbe } from "../../core/model/source.js";
import type { FrameBounds } from "./video-decoder.js";

/**
 * What every decoded frame of a probed file must stay within (docs/adr/0001):
 * the probe's coded size, and timestamps from the track's first one to the
 * end of the probe's duration.
 *
 * @internal
 */
export async function frameBounds(track: InputVideoTrack, probe: VideoProbe): Promise<FrameBounds> {
  const firstTimestamp = Math.round((await track.getFirstTimestamp()) * 1_000_000);
  return {
    codedWidth: probe.video.codedWidth,
    codedHeight: probe.video.codedHeight,
    firstTimestamp,
    lastTimestamp: firstTimestamp + probe.duration,
  };
}
