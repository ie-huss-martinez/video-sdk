// The audio decoder, exposed for tests (docs/adr/0002): it decodes a range of
// a file's audio track and reports what it delivered, and the ledger of open
// AudioData, so tests can prove every chunk is closed on every path.
import { exposeWorker } from "@hussmartinez/sdk-core";
import { audioDataLedger, decodeAudioData } from "../../src/adapters/mediabunny/audio-decoder.js";
import { familyOf, openInput, pickTracks } from "../../src/adapters/mediabunny/tracks.js";
import { probeFile } from "../../src/adapters/probe.js";
import { videoLimits } from "../../src/core/errors/video-limits.js";

export interface AudioDecodeRequest {
  readonly file: Blob;
  readonly from?: number;
  readonly to?: number;
  /** The consumer throws on this delivered chunk, counted from 0. */
  readonly throwAt?: number;
  /** The call is cancelled on this delivered chunk. */
  readonly abortAt?: number;
  /** Decodes with a wrong channel count, so every chunk is out of bounds. */
  readonly wrongChannels?: boolean;
  /** Decodes with another codec's configuration, so that decoding fails. */
  readonly codec?: string;
}

export interface AudioDecodeContract {
  readonly decode: {
    readonly input: AudioDecodeRequest;
    readonly output: { readonly chunks: number; readonly frames: number; readonly first: number };
  };
  readonly ledger: {
    readonly input: undefined;
    readonly output: { readonly open: number; readonly peakDecodeQueue: number };
  };
}

exposeWorker<AudioDecodeContract>({
  async decode(request) {
    const probe = await probeFile(request.file, videoLimits.resolve());
    const input = openInput(request.file, familyOf(probe.container));
    const controller = new AbortController();
    try {
      const { audio } = await pickTracks(input, probe.container);
      const config = audio && (await audio.getDecoderConfig());
      if (!audio || !config) throw new Error("no audio");
      let chunks = 0;
      let frames = 0;
      let first = Number.NaN;
      const { description: _description, ...bare } = config;
      await decodeAudioData(
        audio,
        request.codec
          ? { ...bare, codec: request.codec }
          : request.wrongChannels
            ? { ...config, numberOfChannels: 1 }
            : config,
        {
          from: request.from ?? Number.NEGATIVE_INFINITY,
          to: request.to ?? Number.POSITIVE_INFINITY,
        },
        (data) => {
          if (chunks === 0) first = data.timestamp;
          const index = chunks;
          chunks += 1;
          frames += data.numberOfFrames;
          if (index === request.throwAt) throw new RangeError("the consumer failed");
          if (index === request.abortAt) controller.abort();
        },
        controller.signal,
      );
      return { chunks, frames, first };
    } finally {
      input.dispose();
    }
  },
  ledger: () => ({ ...audioDataLedger }),
});
