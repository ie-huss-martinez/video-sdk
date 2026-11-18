import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoProbe } from "../../core/model/source.js";
import { frameBounds } from "./frame-bounds.js";
import { familyOf, openInput, pickTracks } from "./tracks.js";
import { decodeVideoFrames } from "./video-decoder.js";

/**
 * Whether a file's sound can be played here: `"none"` without an audio
 * track, `"decodable"`, or `"undecodable"`, with its codec, when this browser
 * has no `AudioDecoder` in workers or can't decode the track's codec
 * (docs/adr/0008).
 *
 * @internal
 */
export type AudioSupport =
  | { readonly audio: "none" | "decodable" }
  | { readonly audio: "undecodable"; readonly codec: string };

/**
 * Checks that this browser can decode the tracks the SDK uses from a file
 * that has passed the front check (ADR 0001, ADR 0002): WebCodecs'
 * `VideoDecoder` must exist where this runs, a worker, and the video track's
 * decoder configuration must be supported. Then the first video frame is
 * decoded, checked against the probe and closed, because a browser can
 * claim a codec it then fails to decode.
 *
 * Sound the browser can't decode doesn't stop a file opening: it opens with
 * its picture, and this says so, with the codec (docs/adr/0008).
 *
 * Throws `VideoError`: `UNSUPPORTED_ENVIRONMENT` with `details.feature`
 * without `VideoDecoder`, `UNSUPPORTED_CODEC` with `details.codec` and
 * `details.track: "video"` for a video track the browser can't decode,
 * `DECODE_FAILED` when it claims a codec but its first frame doesn't
 * decode, and `INVALID_VIDEO` if mediabunny can't give a decoder
 * configuration or the frame breaks the probe's bounds.
 *
 * @internal
 */
export async function checkDecoderSupport(
  file: Blob,
  probe: VideoProbe,
  signal?: AbortSignal,
): Promise<AudioSupport> {
  const { container } = probe;
  for (const feature of ["VideoDecoder"] as const) {
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
    const bounds = frameBounds(probe);
    const range = { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY, limit: 1 };
    if ((await decodeVideoFrames(video, videoConfig, bounds, range, () => {}, signal)) === 0) {
      throw new VideoError("DECODE_FAILED", "The video track's first frame didn't decode.", {
        details: { codec: videoCodec },
      });
    }
    if (!audio || probe.audio === null) return { audio: "none" };
    const audioConfig = await audio.getDecoderConfig();
    const codec = audioConfig?.codec ?? probe.audio.codec;
    if (
      typeof AudioDecoder !== "function" ||
      audioConfig === null ||
      !(await AudioDecoder.isConfigSupported(audioConfig)).supported
    ) {
      return { audio: "undecodable", codec };
    }
    return { audio: "decodable" };
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
