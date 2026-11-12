import { type EncodedPacket, EncodedPacketSink, type InputVideoTrack } from "mediabunny";
import { abortError } from "../../core/errors/error-helpers.js";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import { CODED_PADDING } from "../../core/model/probe-limits.js";

/** The most packets waiting in the decoder's own queue (docs/adr/0002). */
export const MAX_DECODE_QUEUE = 8;
/**
 * The most packets the decoder's queue may grow to while the decoder holds
 * them without output (docs/adr/0002). Firefox decodes VP8 on several threads
 * at once and outputs nothing until about as many packets as it has threads
 * are in flight, which can be more than {@link MAX_DECODE_QUEUE}.
 */
export const MAX_STALLED_DECODE_QUEUE = 32;
/** How long a full queue may go without output before the decoder is given one more packet, in milliseconds. */
export const STALL_TIMEOUT = 50;
/** The most decoded frames waiting for their consumer while packets are fed (docs/adr/0002). */
export const MAX_QUEUED_FRAMES = 4;

/**
 * Counts the `VideoFrame`s this worker's decoders have output and not yet
 * closed, the deepest the decoder's queue has been, and how many times a
 * stalled decoder was given one more packet, for the tests that prove every
 * frame is closed on every path and the queue grows only on a stall
 * (docs/adr/0002).
 *
 * @internal
 */
export const videoFrameLedger = { open: 0, peakDecodeQueue: 0, stalls: 0 };

/**
 * What a decoded frame must stay within: the probe's coded size and the
 * track's walked timestamps, in microseconds (docs/adr/0001).
 */
export interface FrameBounds {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
}

/** Which frames to decode, by presentation time in microseconds. */
export interface FrameRange {
  /** The first timestamp to deliver, inclusive. */
  readonly from: number;
  /** The timestamp to stop before, exclusive. */
  readonly to: number;
  /** Stop after delivering this many frames. */
  readonly limit?: number;
}

/**
 * Decodes the frames of `range` from a video track with WebCodecs, in the
 * worker, and lends each one to `onFrame` in presentation order (docs/adr/0001,
 * docs/adr/0002). Decoding starts at the key packet before `range.from`.
 *
 * - **Bounded:** at most {@link MAX_DECODE_QUEUE} packets wait in the
 *   decoder, with back-pressure on its `dequeue` event, and no packet is fed
 *   while {@link MAX_QUEUED_FRAMES} decoded frames wait for `onFrame`. A
 *   decoder that holds a full queue without output gets one more packet at a
 *   time, up to {@link MAX_STALLED_DECODE_QUEUE}, so one that needs more
 *   packets in flight than that bound can't deadlock. One that still holds
 *   them all without output fails with `DECODE_FAILED` and
 *   `details.reason: "stalled"`.
 * - **Borrowed frames:** a frame is closed as soon as `onFrame` settles, so
 *   every frame is closed in one place. `onFrame` clones a frame to keep it,
 *   and then owns the clone.
 * - **Checked:** a frame whose visible picture is larger than `bounds`, whose
 *   coded size exceeds them by more than {@link CODED_PADDING}, or whose
 *   timestamp is outside the track's walked range, closes everything and
 *   fails with `INVALID_VIDEO`. Frames
 *   outside `range` are closed without being delivered.
 * - **Closed on every path:** on success, failure, a consumer that throws, or
 *   cancellation, every frame waiting is closed, and so is the decoder.
 *
 * Throws `VideoError`: `DECODE_FAILED` with `details.codec` when the browser
 * fails to decode, and `details.reason: "stalled"` when it stops producing
 * frames, `INVALID_VIDEO` for a frame out of bounds, and `ABORTED`
 * or the abort reason's code when cancelled. Whatever `onFrame` throws is
 * passed on as it is. Resolves with the number of frames delivered.
 *
 * @internal
 */
export async function decodeVideoFrames(
  track: InputVideoTrack,
  config: VideoDecoderConfig,
  bounds: FrameBounds,
  range: FrameRange,
  onFrame: (frame: VideoFrame) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  const limit = range.limit ?? Number.POSITIVE_INFINITY;
  const waiting: VideoFrame[] = [];
  let failure: unknown;
  /** What the consumer threw, which is passed on as it is. */
  let consumerFailure: unknown;
  let delivered = 0;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const close = (frame: VideoFrame) => {
    frame.close();
    videoFrameLedger.open -= 1;
  };

  const decoder = new VideoDecoder({
    output(frame) {
      videoFrameLedger.open += 1;
      waiting.push(frame);
      notify();
    },
    error(error) {
      failure ??= new VideoError("DECODE_FAILED", "The browser couldn't decode the video track.", {
        details: { codec: config.codec },
        cause: error,
      });
      notify();
    },
  });
  decoder.addEventListener("dequeue", notify);
  signal?.addEventListener("abort", notify);

  const check = () => {
    if (signal?.aborted) throw abortError(signal);
    if (failure !== undefined) throw failure;
  };
  /**
   * Waits for the decoder, cancellation or a failure, unless `ready` already
   * holds. When nothing happens for {@link STALL_TIMEOUT}, `onStall` is
   * called, and may make `ready` hold.
   */
  const until = async (ready: () => boolean, onStall?: () => void) => {
    while (!ready()) {
      check();
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (ready() || signal?.aborted || failure !== undefined) return notify();
        if (onStall) {
          timer = setTimeout(() => {
            stalled = true;
            notify();
          }, STALL_TIMEOUT);
        }
      });
      clearTimeout(timer);
      if (stalled) onStall?.();
    }
    check();
  };
  /**
   * How many packets may wait in the decoder. A decoder that holds a full
   * queue without output, with no frame waiting for the consumer, needs more
   * packets before it can output one: it gets one more at a time, up to
   * {@link MAX_STALLED_DECODE_QUEUE}.
   */
  let queueLimit = MAX_DECODE_QUEUE;
  const onStall = () => {
    if (waiting.length > 0 || decoder.decodeQueueSize < queueLimit) return;
    if (queueLimit >= MAX_STALLED_DECODE_QUEUE) {
      throw new VideoError(
        "DECODE_FAILED",
        "The browser's decoder stopped producing frames for the video track.",
        { details: { codec: config.codec, reason: "stalled" } },
      );
    }
    queueLimit += 1;
    videoFrameLedger.stalls += 1;
  };
  /** Lends every waiting frame to the consumer, in order. */
  const drain = async () => {
    while (waiting.length > 0) {
      const frame = waiting.shift() as VideoFrame;
      try {
        const visible = frame.visibleRect;
        const width = visible?.width ?? frame.codedWidth;
        const height = visible?.height ?? frame.codedHeight;
        if (
          width > bounds.codedWidth ||
          height > bounds.codedHeight ||
          frame.codedWidth > bounds.codedWidth + CODED_PADDING ||
          frame.codedHeight > bounds.codedHeight + CODED_PADDING
        ) {
          throw new VideoError(
            "INVALID_VIDEO",
            "A decoded frame is larger than the probe allows.",
            {
              details: { reason: "frame-size" },
            },
          );
        }
        if (frame.timestamp < bounds.firstTimestamp || frame.timestamp > bounds.lastTimestamp) {
          throw new VideoError(
            "INVALID_VIDEO",
            "A decoded frame is outside the track's timestamps.",
            {
              details: { reason: "frame-timestamp" },
            },
          );
        }
        if (frame.timestamp >= range.from && frame.timestamp < range.to && delivered < limit) {
          delivered += 1;
          try {
            await onFrame(frame);
          } catch (error) {
            consumerFailure = error;
            throw error;
          }
        }
      } finally {
        close(frame);
      }
      check();
    }
  };

  try {
    configure(decoder, config);
    const sink = new EncodedPacketSink(track);
    const start =
      (await sink.getKeyPacket(range.from / 1_000_000)) ?? (await sink.getFirstPacket());
    let packet: EncodedPacket | null = start;
    while (packet !== null && delivered < limit) {
      check();
      // Packets after the range can't hold frames in it, once the decoder
      // has seen a key packet past its end.
      if (packet.type === "key" && packet !== start && packet.microsecondTimestamp >= range.to)
        break;
      await until(
        () => decoder.decodeQueueSize < queueLimit && waiting.length < MAX_QUEUED_FRAMES,
        onStall,
      );
      decoder.decode(packet.toEncodedVideoChunk());
      videoFrameLedger.peakDecodeQueue = Math.max(
        videoFrameLedger.peakDecodeQueue,
        decoder.decodeQueueSize,
      );
      await drain();
      packet = await sink.getNextPacket(packet);
    }
    if (delivered < limit) {
      await decoder.flush();
      await drain();
    }
    check();
    return delivered;
  } catch (error) {
    if (isVideoError(error) || (consumerFailure !== undefined && error === consumerFailure)) {
      throw error;
    }
    if (failure !== undefined) throw failure;
    if (signal?.aborted) throw abortError(signal);
    throw new VideoError("DECODE_FAILED", "The browser couldn't decode the video track.", {
      details: { codec: config.codec },
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", notify);
    for (const frame of waiting.splice(0)) close(frame);
    if (decoder.state !== "closed") decoder.close();
  }
}

function configure(decoder: VideoDecoder, config: VideoDecoderConfig): void {
  try {
    decoder.configure(config);
  } catch (cause) {
    throw new VideoError(
      "DECODE_FAILED",
      "The browser couldn't set up a decoder for the video track.",
      {
        details: { codec: config.codec },
        cause,
      },
    );
  }
}
