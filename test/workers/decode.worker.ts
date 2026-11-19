// The frame decoder, exposed for tests (docs/adr/0002): it decodes a range of
// a file's video track and reports what it delivered, and the ledger of open
// frames, so tests can prove every frame is closed on every path.
import { exposeWorker } from "@hussmartinez/sdk-core";
import { frameBounds } from "../../src/adapters/mediabunny/frame-bounds.js";
import { familyOf, openInput, pickTracks } from "../../src/adapters/mediabunny/tracks.js";
import {
  decodeVideoFrames,
  videoFrameLedger,
} from "../../src/adapters/mediabunny/video-decoder.js";
import { probeFile } from "../../src/adapters/probe.js";
import { videoLimits } from "../../src/core/errors/video-limits.js";
import type { VideoProbe } from "../../src/core/model/source.js";
import { laggingDecoderClass, lateOutputDecoderClass, standInsClosed } from "./lagging-decoder.js";

export interface DecodeRequest {
  readonly file: Blob;
  readonly from?: number;
  readonly to?: number;
  readonly limit?: number;
  /** The consumer throws on this delivered frame, counted from 0. */
  readonly throwAt?: number;
  /** The call is cancelled on this delivered frame. */
  readonly abortAt?: number;
  /** Bounds smaller than the probe's, to make every frame out of bounds. */
  readonly shrinkBounds?: boolean;
  /** Decodes with another codec's configuration, so that decoding fails. */
  readonly codec?: string;
  /** Holds this many packets before decoding them, as Firefox's frame-threaded decoding does. */
  readonly lag?: number;
  /** With `lag`: four frames come at once when the queue is full. */
  readonly burst?: boolean;
  /** With `lag`: a decoder that stopped, or one that waits for its frames back before its flush settles. */
  readonly mode?: "stuck" | "pool";
  /** The consumer holds this delivered frame, counted from 0, for `holdMs`. */
  readonly holdAt?: number;
  readonly holdMs?: number;
  /** Delivers one more frame after the decoder is closed, as Firefox can. */
  readonly lateOutput?: boolean;
}

export interface DecodeContract {
  readonly decode: {
    readonly input: DecodeRequest;
    readonly output: { readonly timestamps: number[]; readonly sizes: [number, number][] };
  };
  readonly ledger: {
    readonly input: undefined;
    readonly output: {
      readonly open: number;
      readonly peakDecodeQueue: number;
      readonly stalls: number;
    };
  };
  /** How many stand-in decoders have been closed. */
  readonly standInsClosed: { readonly input: undefined; readonly output: number };
  /** Starts counting the queue's peak and the stalls afresh, for one test. */
  readonly resetLedger: { readonly input: undefined; readonly output: undefined };
}

/** Another codec's configuration, without this one's description. */
function withCodec(config: VideoDecoderConfig, codec: string): VideoDecoderConfig {
  const { description: _description, ...rest } = config;
  return { ...rest, codec };
}

exposeWorker<DecodeContract>({
  async decode(request) {
    const probe: VideoProbe = await probeFile(request.file, videoLimits.resolve());
    const input = openInput(request.file, familyOf(probe.container));
    const controller = new AbortController();
    const RealDecoder = globalThis.VideoDecoder;
    if (request.lag !== undefined) {
      globalThis.VideoDecoder = laggingDecoderClass(
        request.lag,
        request.burst ?? false,
        request.mode,
      );
    }
    if (request.lateOutput) globalThis.VideoDecoder = lateOutputDecoderClass();
    try {
      const { video } = await pickTracks(input, probe.container);
      const config = (await video.getDecoderConfig()) as VideoDecoderConfig;
      const bounds = frameBounds(probe);
      const timestamps: number[] = [];
      const sizes: [number, number][] = [];
      await decodeVideoFrames(
        video,
        request.codec ? withCodec(config, request.codec) : config,
        request.shrinkBounds ? { ...bounds, codedWidth: 16, codedHeight: 16 } : bounds,
        {
          from: request.from ?? Number.NEGATIVE_INFINITY,
          to: request.to ?? Number.POSITIVE_INFINITY,
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        },
        async (frame) => {
          const index = timestamps.length;
          if (index === request.holdAt) {
            await new Promise((resolve) => setTimeout(resolve, request.holdMs ?? 0));
          }
          timestamps.push(frame.timestamp);
          sizes.push([frame.codedWidth, frame.codedHeight]);
          if (index === request.throwAt) throw new RangeError("the consumer failed");
          if (index === request.abortAt) controller.abort();
        },
        controller.signal,
      );
      return { timestamps, sizes };
    } finally {
      globalThis.VideoDecoder = RealDecoder;
      input.dispose();
    }
  },
  ledger: () => ({ ...videoFrameLedger }),
  standInsClosed: () => standInsClosed.video,
  resetLedger() {
    videoFrameLedger.peakDecodeQueue = 0;
    videoFrameLedger.stalls = 0;
    return undefined;
  },
});
