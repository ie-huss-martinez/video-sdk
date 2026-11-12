import { type EncodedPacket, EncodedPacketSink, type InputTrack } from "mediabunny";
import { throwIfAborted } from "../../core/errors/error-helpers.js";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import type { VideoFilePolicy } from "../../core/errors/video-limits.js";
import type { AudioTrackProbe, VideoRotation, VideoTrackProbe } from "../../core/model/source.js";
import { packetCaps } from "../front-check/front-check.js";
import type { FrontCheck } from "../front-check/types.js";
import { codecOf, openInput, pickTracks } from "./tracks.js";

/** How many packets between checks of the abort signal. */
const ABORT_EVERY = 1_024;

/**
 * What walking every packet of the tracks the SDK uses found (ADR 0001).
 *
 * @internal
 */
export interface PacketWalk {
  /** The earliest presentation timestamp of the tracks walked, in microseconds. */
  readonly start: number;
  /** The length in microseconds from `start`: the larger of the header's and the walk's. */
  readonly duration: number;
  readonly peakBitrate: number;
  readonly maxPacketSize: number;
  readonly video: VideoTrackProbe;
  readonly audio: AudioTrackProbe | null;
}

/** The most timestamps, in microseconds, within any window of one second. */
function peakPerSecond(timestamps: Float64Array): number {
  timestamps.sort();
  let peak = 0;
  let first = 0;
  for (let last = 0; last < timestamps.length; last += 1) {
    while ((timestamps[last] as number) - (timestamps[first] as number) >= 1_000_000) first += 1;
    peak = Math.max(peak, last - first + 1);
  }
  return peak;
}

/**
 * Opens a front-checked file with mediabunny, restricted to its family's
 * formats, picks the video track and an audio track, and walks every packet
 * of both with `metadataOnly`, reading sizes and timestamps but no packet
 * data (ADR 0001). The walk stops as soon as a track has more packets than
 * the limits allow.
 *
 * Throws `VideoError`: `UNSUPPORTED_FORMAT` for a file with no video track or
 * a mirrored one, `UNSUPPORTED_CODEC` for a video codec mediabunny doesn't
 * know, `FRAME_RATE_TOO_HIGH` or `DURATION_TOO_LONG` past the packet caps,
 * `INVALID_VIDEO` for anything mediabunny can't read, and `ABORTED` or the
 * abort reason's code when cancelled.
 *
 * @internal
 */
export async function walkPackets(
  file: Blob,
  front: FrontCheck,
  policy: VideoFilePolicy,
  signal?: AbortSignal,
): Promise<PacketWalk> {
  const input = openInput(file, front.family);
  const container = front.container;
  try {
    const { video, videoCodec, audio } = await pickTracks(input, container);

    const caps = packetCaps(policy);
    const seconds = policy.limits.maxDuration.maximum / 1_000;
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    let maxPacketSize = 0;
    const bytesPerSecond = new Map<number, number>();

    const walk = async (
      track: InputTrack,
      cap: number,
      onPacket?: (packet: EncodedPacket) => void,
    ) => {
      let count = 0;
      const sink = new EncodedPacketSink(track);
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        count += 1;
        if (count > cap) {
          const isVideo = track === video;
          const limit = isVideo ? "maxFrameRate" : "maxDuration";
          throw new VideoError(
            isVideo ? "FRAME_RATE_TOO_HIGH" : "DURATION_TOO_LONG",
            `The ${isVideo ? "video" : "audio"} track has more packets than the limits allow.`,
            {
              details: {
                limit,
                maximum: policy.limits[limit].maximum,
                actual: isVideo ? count / seconds : policy.limits.maxDuration.maximum + 1,
                unit: isVideo ? "count" : "milliseconds",
              },
            },
          );
        }
        if (count % ABORT_EVERY === 0) throwIfAborted(signal);
        // Whole microseconds, so that rounding can't move a packet across a second.
        const time = packet.microsecondTimestamp;
        start = Math.min(start, time);
        end = Math.max(end, time + packet.microsecondDuration);
        maxPacketSize = Math.max(maxPacketSize, packet.byteLength);
        const second = Math.floor(time / 1_000_000);
        bytesPerSecond.set(second, (bytesPerSecond.get(second) ?? 0) + packet.byteLength);
        onPacket?.(packet);
      }
      return count;
    };

    // Every frame's timestamp, for the peak frame rate (ADR 0004).
    let timestamps = new Float64Array(1_024);
    let stored = 0;
    const frames = await walk(video, caps.video, (packet) => {
      if (stored === timestamps.length) {
        const grown = new Float64Array(timestamps.length * 2);
        grown.set(timestamps);
        timestamps = grown;
      }
      timestamps[stored] = packet.microsecondTimestamp;
      stored += 1;
    });
    if (frames === 0) {
      throw new VideoError("INVALID_VIDEO", "The video track has no frames.", {
        details: { container, reason: "no-frames" },
      });
    }
    if (audio) await walk(audio, caps.audio);
    throwIfAborted(signal);

    const walked = end - start;
    const claimedSeconds = await input.getDurationFromMetadata();
    // The metadata gives an end timestamp, so its length counts from `start`.
    const claimed = claimedSeconds === null ? 0 : Math.round(claimedSeconds * 1_000_000) - start;
    const rotation = (await video.getRotation()) as VideoRotation;

    return {
      start,
      duration: Math.max(walked, claimed),
      peakBitrate: Math.max(0, ...bytesPerSecond.values()) * 8,
      maxPacketSize,
      video: {
        codec: videoCodec,
        codedWidth: await video.getCodedWidth(),
        codedHeight: await video.getCodedHeight(),
        displayWidth: await video.getSquarePixelWidth(),
        displayHeight: await video.getSquarePixelHeight(),
        rotation,
        frameRate: peakPerSecond(timestamps.subarray(0, frames)),
        packets: frames,
      },
      audio: audio
        ? {
            codec: (await codecOf(audio)) as string,
            sampleRate: await audio.getSampleRate(),
            channels: await audio.getNumberOfChannels(),
          }
        : null,
    };
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
