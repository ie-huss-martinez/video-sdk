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
import { laggingDecoderClass } from "./lagging-decoder.js";

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
    if (request.lag !== undefined) globalThis.VideoDecoder = laggingDecoderClass(request.lag);
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
        (frame) => {
          const index = timestamps.length;
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
  resetLedger() {
    videoFrameLedger.peakDecodeQueue = 0;
    videoFrameLedger.stalls = 0;
    return undefined;
  },
});
