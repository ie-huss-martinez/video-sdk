import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoContainer } from "../../core/model/source.js";
import { familyOf, openInput, pickTracks } from "./tracks.js";

/**
 * Checks that this browser can decode the tracks the SDK uses from a file
 * it has already probed (ADR 0001, ADR 0002): WebCodecs' `VideoDecoder` and
 * `AudioDecoder` must exist where this runs, a worker, and each track's
 * decoder configuration must be supported. Nothing is decoded or configured;
 * `isConfigSupported` only asks.
 *
 * Throws `VideoError`: `UNSUPPORTED_ENVIRONMENT` with `details.feature`
 * without WebCodecs, `UNSUPPORTED_CODEC` with `details.codec` and
 * `details.track` for a track the browser can't decode, and `INVALID_VIDEO`
 * if mediabunny can't give a decoder configuration.
 *
 * @internal
 */
export async function checkDecoderSupport(file: Blob, container: VideoContainer): Promise<void> {
  for (const feature of ["VideoDecoder", "AudioDecoder"] as const) {
    if (typeof globalThis[feature] !== "function") {
      throw new VideoError(
        "UNSUPPORTED_ENVIRONMENT",
        `This browser has no ${feature} in workers.`,
        {
          details: { feature },
        },
      );
    }
  }
  const input = openInput(file, familyOf(container));
  try {
    const { video, videoCodec, audio } = await pickTracks(input, container);
    const videoConfig = await video.getDecoderConfig();
    if (videoConfig === null || !(await VideoDecoder.isConfigSupported(videoConfig)).supported) {
      throw new VideoError("UNSUPPORTED_CODEC", "This browser can't decode the video track.", {
        details: { codec: videoCodec, track: "video" },
      });
    }
    if (audio) {
      const audioConfig = await audio.getDecoderConfig();
      if (audioConfig === null || !(await AudioDecoder.isConfigSupported(audioConfig)).supported) {
        throw new VideoError("UNSUPPORTED_CODEC", "This browser can't decode the audio track.", {
          details: { codec: audioConfig?.codec ?? "unknown", track: "audio" },
        });
      }
    }
  } catch (error) {
    if (isVideoError(error)) throw error;
    throw new VideoError("INVALID_VIDEO", "The file couldn't be read.", {
      details: { container, reason: "demux" },
      cause: error,
    });
  } finally {
    input.dispose();
  }
}
