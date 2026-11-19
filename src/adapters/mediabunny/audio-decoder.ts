import { type EncodedPacket, EncodedPacketSink, type InputAudioTrack } from "mediabunny";
import { abortError } from "../../core/errors/error-helpers.js";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import { MAX_DECODE_QUEUE, MAX_STALLED_DECODE_QUEUE, STALL_TIMEOUT } from "./video-decoder.js";

/**
 * Counts the `AudioData` this worker's decoders have output and not yet
 * closed, the deepest the decoder's queue has been, and how many times a
 * stalled decoder was given one more packet, for the tests that prove every
 * chunk is closed on every path and the queue grows only on a stall
 * (docs/adr/0002).
 *
 * @internal
 */
export const audioDataLedger = { open: 0, peakDecodeQueue: 0, restamped: 0, stalls: 0 };

/**
 * How long a flush may go without output or a `dequeue` before the decoder
 * is taken to have stopped, in milliseconds. A flush decodes the packets
 * still queued, each in far less; one that gives nothing back for this long
 * never will.
 */
export const FLUSH_STALL_TIMEOUT = 2_000;

/**
 * The most frames one decoded chunk may hold, by codec (docs/adr/0001): the
 * codec's largest frame. A chunk with more fails with `INVALID_VIDEO`.
 */
function maxFramesPerChunk(codec: string): number {
  if (codec === "opus") return 5_760;
  if (codec === "vorbis") return 8_192;
  if (codec === "mp3" || codec === "mp4a.6b" || codec === "mp4a.69") return 1_152;
  if (codec.startsWith("mp4a.")) return 2_048;
  // FLAC's largest block, and the bound for anything else, such as PCM.
  return 65_535;
}

/** Which audio to decode, by presentation time in microseconds. */
export interface AudioRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Decodes an audio track with WebCodecs, in the worker, and lends each chunk
 * to `onData` in order (docs/adr/0001, docs/adr/0002), with the same
 * discipline as the video decoder.
 *
 * - **Bounded:** at most `MAX_DECODE_QUEUE` packets wait in the decoder, with
 *   back-pressure on its `dequeue` event, and no packet is fed while a
 *   decoded chunk waits for `onData`: chunks that come while the loop waits
 *   for room are drained first, since nothing else takes them.
 * - **Never waiting forever,** as the video decoder: a decoder that holds a
 *   full queue without output for `STALL_TIMEOUT` is given one more packet
 *   at a time, up to `MAX_STALLED_DECODE_QUEUE`, so one that needs more
 *   before its first output still decodes, and one that holds them all, or
 *   whose `dequeue` never comes, fails with `DECODE_FAILED` and
 *   `details.reason: "stalled"`. So does a flush that gives back nothing
 *   for `FLUSH_STALL_TIMEOUT`, as from a decoder that stopped altogether.
 * - **Borrowed chunks:** a chunk is closed as soon as `onData` settles;
 *   `onData` clones one to keep it.
 * - **Placed by the stream:** `onData` gets each chunk's time with it. It's
 *   the chunk's own timestamp when that's within half a chunk of where the
 *   chunks before it end, and otherwise that end. WebKit's decoder stamps
 *   chunks seconds away from their packets; chunks are always contiguous,
 *   so the stream says where each belongs. The first is placed by its
 *   packet.
 * - **Checked:** a chunk whose sample rate or channel count differs from
 *   `config`, or which holds more frames than its codec's largest frame,
 *   closes everything and fails with `INVALID_VIDEO`. Chunks wholly outside
 *   `range` are closed without being delivered.
 * - **Closed on every path,** with the decoder.
 *
 * Throws `VideoError`: `DECODE_FAILED` with `details.codec` when the browser
 * fails to decode, `INVALID_VIDEO` for a chunk out of bounds, and `ABORTED`
 * or the abort reason's code when cancelled. Whatever `onData` throws is
 * passed on as it is. Resolves with the number of chunks delivered.
 *
 * @internal
 */
export async function decodeAudioData(
  track: InputAudioTrack,
  config: AudioDecoderConfig,
  range: AudioRange,
  onData: (data: AudioData, timestamp: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  const maxFrames = maxFramesPerChunk(config.codec);
  /** Set once the call settles; any output after it is closed at once. */
  let finished = false;
  const waiting: AudioData[] = [];
  let failure: unknown;
  let consumerFailure: unknown;
  let delivered = 0;
  /** Where the next chunk belongs, in microseconds: the first packet's time, then each chunk's end. */
  let expected: number | undefined;
  let wake: (() => void) | undefined;
  /** When the decoder last gave something back: an output, or a `dequeue`. */
  let heard = performance.now();
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const close = (data: AudioData) => {
    data.close();
    audioDataLedger.open -= 1;
  };

  const decoder = new AudioDecoder({
    output(data) {
      // Firefox can run an output task it queued before close(): nothing
      // would take this one, so it's closed here.
      if (finished) return data.close();
      audioDataLedger.open += 1;
      heard = performance.now();
      waiting.push(data);
      notify();
    },
    error(error) {
      failure ??= new VideoError("DECODE_FAILED", "The browser couldn't decode the audio track.", {
        details: { codec: config.codec },
        cause: error,
      });
      notify();
    },
  });
  decoder.addEventListener("dequeue", () => {
    heard = performance.now();
    notify();
  });
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
  const until = async (ready: () => boolean, onStall: () => void) => {
    while (!ready()) {
      check();
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (ready() || signal?.aborted || failure !== undefined) return notify();
        timer = setTimeout(() => {
          stalled = true;
          notify();
        }, STALL_TIMEOUT);
      });
      clearTimeout(timer);
      if (stalled) onStall();
    }
    check();
  };
  /**
   * How many packets may wait in the decoder. A decoder that holds a full
   * queue without output, with no chunk waiting for the consumer, needs more
   * packets before it can output one, or its `dequeue` never came: it gets
   * one more at a time, up to {@link MAX_STALLED_DECODE_QUEUE}.
   */
  let queueLimit = MAX_DECODE_QUEUE;
  const stalledError = () =>
    new VideoError("DECODE_FAILED", "The browser's decoder stopped producing audio.", {
      details: { codec: config.codec, reason: "stalled", track: "audio" },
    });
  const onStall = () => {
    if (waiting.length > 0 || decoder.decodeQueueSize < queueLimit) return;
    if (queueLimit >= MAX_STALLED_DECODE_QUEUE) throw stalledError();
    queueLimit += 1;
    audioDataLedger.stalls += 1;
  };
  const drain = async () => {
    while (waiting.length > 0) {
      const data = waiting.shift() as AudioData;
      try {
        if (
          data.sampleRate !== config.sampleRate ||
          data.numberOfChannels !== config.numberOfChannels ||
          data.numberOfFrames > maxFrames
        ) {
          throw new VideoError("INVALID_VIDEO", "Decoded audio doesn't match its track.", {
            details: { reason: "audio-chunk" },
          });
        }
        const duration = (data.numberOfFrames * 1_000_000) / data.sampleRate;
        let timestamp = data.timestamp;
        if (expected !== undefined && Math.abs(timestamp - expected) > duration / 2) {
          timestamp = expected;
          audioDataLedger.restamped += 1;
        }
        expected = timestamp + duration;
        const end = timestamp + duration;
        if (end > range.from && timestamp < range.to) {
          delivered += 1;
          try {
            await onData(data, timestamp);
          } catch (error) {
            consumerFailure = error;
            throw error;
          }
        }
      } finally {
        close(data);
      }
      check();
    }
  };

  try {
    try {
      decoder.configure(config);
    } catch (cause) {
      throw new VideoError(
        "DECODE_FAILED",
        "The browser couldn't set up a decoder for the audio track.",
        {
          details: { codec: config.codec },
          cause,
        },
      );
    }
    const sink = new EncodedPacketSink(track);
    // Audio packets are all key packets; start at the one covering `from`.
    let packet: EncodedPacket | null =
      (await sink.getPacket(Math.max(0, range.from) / 1_000_000)) ?? (await sink.getFirstPacket());
    while (packet !== null && packet.microsecondTimestamp < range.to) {
      check();
      // Room for one more packet. Output that came meanwhile, as while the
      // next packet was read, is drained first: the wait can't take it, and
      // would never end with it waiting.
      await drain();
      while (decoder.decodeQueueSize >= queueLimit) {
        await until(() => waiting.length > 0 || decoder.decodeQueueSize < queueLimit, onStall);
        await drain();
      }
      expected ??= packet.microsecondTimestamp;
      decoder.decode(packet.toEncodedAudioChunk());
      audioDataLedger.peakDecodeQueue = Math.max(
        audioDataLedger.peakDecodeQueue,
        decoder.decodeQueueSize,
      );
      await drain();
      packet = await sink.getNextPacket(packet);
    }
    // The flush, bounded: a decoder that stopped would leave it pending.
    let flushed = false;
    const flushing = decoder.flush().finally(() => {
      flushed = true;
      notify();
    });
    flushing.catch(() => {});
    heard = performance.now();
    await until(
      () => flushed,
      () => {
        if (performance.now() - heard < FLUSH_STALL_TIMEOUT) return;
        throw stalledError();
      },
    );
    await flushing;
    await drain();
    check();
    return delivered;
  } catch (error) {
    if (isVideoError(error) || (consumerFailure !== undefined && error === consumerFailure)) {
      throw error;
    }
    if (failure !== undefined) throw failure;
    if (signal?.aborted) throw abortError(signal);
    throw new VideoError("DECODE_FAILED", "The browser couldn't decode the audio track.", {
      details: { codec: config.codec },
      cause: error,
    });
  } finally {
    finished = true;
    signal?.removeEventListener("abort", notify);
    for (const data of waiting.splice(0)) close(data);
    if (decoder.state !== "closed") decoder.close();
  }
}
