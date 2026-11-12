import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoProbe } from "../../core/model/source.js";
import { frameBounds } from "./frame-bounds.js";
import { familyOf, openInput, pickTracks } from "./tracks.js";
import { decodeVideoFrames } from "./video-decoder.js";

/**
 * Checks that this browser can decode the tracks the SDK uses from a file
 * that has passed the front check (ADR 0001, ADR 0002): WebCodecs'
 * `VideoDecoder` and `AudioDecoder` must exist where this runs, a worker, and
 * each track's decoder configuration must be supported. Then the first video
 * frame is decoded, checked against the probe and closed, because a browser
 * can claim a codec it then fails to decode.
 *
 * Throws `VideoError`: `UNSUPPORTED_ENVIRONMENT` with `details.feature`
 * without WebCodecs, `UNSUPPORTED_CODEC` with `details.codec` and
 * `details.track` for a track the browser can't decode, `DECODE_FAILED` when
 * it claims a codec but its first frame doesn't decode, and `INVALID_VIDEO`
 * if mediabunny can't give a decoder configuration or the frame breaks the
 * probe's bounds.
 *
 * @internal
 */
export async function checkDecoderSupport(
  file: Blob,
  probe: VideoProbe,
  signal?: AbortSignal,
): Promise<void> {
  const { container } = probe;
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
    const bounds = await frameBounds(video, probe);
    const range = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, limit: 1 };
    if ((await decodeVideoFrames(video, videoConfig, bounds, range, () => {}, signal)) === 0) {
      throw new VideoError("DECODE_FAILED", "The video track's first frame didn't decode.", {
        details: { codec: videoCodec },
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
