import type { InputAudioTrack, InputVideoTrack } from "mediabunny";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoProbe } from "../../core/model/source.js";
import { type AudioRange, decodeAudioData } from "./audio-decoder.js";
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
  /**
   * The audio track the probe read, or `null` without one. It decodes a
   * range with `decodeAudioData`, lending each chunk to `onData`.
   */
  readonly audio: {
    decode(
      range: AudioRange,
      onData: (data: AudioData, timestamp: number) => void | Promise<void>,
      signal: AbortSignal,
    ): Promise<number>;
  } | null;
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
  let audioTrack: InputAudioTrack | undefined;
  let audioConfig: AudioDecoderConfig | null = null;
  try {
    const tracks = await pickTracks(input, probe.container);
    track = tracks.video;
    config = await track.getDecoderConfig();
    // Only the audio track the probe found; a file probed without audio plays silent.
    if (probe.audio && tracks.audio) {
      audioTrack = tracks.audio;
      audioConfig = await audioTrack.getDecoderConfig();
    }
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
  const audio =
    audioTrack && audioConfig
      ? {
          decode: (
            range: AudioRange,
            onData: (data: AudioData, timestamp: number) => void | Promise<void>,
            signal: AbortSignal,
          ) => decodeAudioData(audioTrack, audioConfig, range, onData, signal),
        }
      : null;
  return {
    decode: (range, onFrame, signal) =>
      decodeVideoFrames(track, decoderConfig, bounds, range, onFrame, signal),
    audio,
    dispose: () => input.dispose(),
  };
}
