import type { InputVideoTrack } from "mediabunny";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoProbe } from "../../core/model/source.js";
import { frameBounds } from "./frame-bounds.js";
import { familyOf, openInput, pickTracks } from "./tracks.js";
import { decodeVideoFrames, type FrameRange } from "./video-decoder.js";

/**
 * A source's video track, open for playback (docs/adr/0006): the scheduler
 * decodes one range after another from it, and from two at once at a cut.
 *
 * @internal
 */
export interface FrameReader {
  /** Decodes a range with {@link decodeVideoFrames}, lending each frame to `onFrame`. */
  decode(
    range: FrameRange,
    onFrame: (frame: VideoFrame) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<number>;
  /** Releases the file. Decoding afterwards fails. */
  dispose(): void;
}

/**
 * Opens a file that has passed the front check for playback: the same video
 * track the probe read, its decoder configuration, and its frame bounds.
 *
 * Throws `VideoError`: `INVALID_VIDEO` when mediabunny can't give a decoder
 * configuration, and the codes of {@link pickTracks}.
 *
 * @internal
 */
export async function openFrameReader(file: Blob, probe: VideoProbe): Promise<FrameReader> {
  const input = openInput(file, familyOf(probe.container));
  let track: InputVideoTrack;
  let config: VideoDecoderConfig | null;
  try {
    track = (await pickTracks(input, probe.container)).video;
    config = await track.getDecoderConfig();
  } catch (error) {
    input.dispose();
    if (isVideoError(error)) throw error;
    throw new VideoError("INVALID_VIDEO", "The file couldn't be read.", {
      details: { container: probe.container, reason: "demux" },
      cause: error,
    });
  }
  if (config === null) {
    input.dispose();
    throw new VideoError("INVALID_VIDEO", "The video track has no decoder configuration.", {
      details: { container: probe.container, reason: "demux" },
    });
  }
  const decoderConfig = config;
  const bounds = frameBounds(probe);
  return {
    decode: (range, onFrame, signal) =>
      decodeVideoFrames(track, decoderConfig, bounds, range, onFrame, signal),
    dispose: () => input.dispose(),
  };
}
