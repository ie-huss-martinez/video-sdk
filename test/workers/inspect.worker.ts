// Reads back an exported file (docs/adr/0005): every frame's number, from the
// export fixtures' blocks, and the metadata the file carries. It decodes with
// the SDK's own probe and decoder, so it checks the file as a user's player
// would read it, in the engine that made it.
import { exposeWorker } from "@hussmartinez/sdk-core";
import { frameBounds } from "../../src/adapters/mediabunny/frame-bounds.js";
import { familyOf, openInput, pickTracks } from "../../src/adapters/mediabunny/tracks.js";
import { decodeVideoFrames } from "../../src/adapters/mediabunny/video-decoder.js";
import { probeFile } from "../../src/adapters/probe.js";
import { videoLimits } from "../../src/core/errors/video-limits.js";

export interface InspectContract {
  readonly inspect: {
    readonly input: Blob;
    readonly output: {
      readonly numbers: number[];
      readonly timestamps: number[];
      readonly metadata: Record<string, string>;
      readonly container: string;
      readonly videoCodec: string;
      readonly audioCodec: string | null;
      readonly tracks: number;
    };
  };
}

exposeWorker<InspectContract>({
  async inspect(file) {
    const probe = await probeFile(file, videoLimits.resolve());
    const input = openInput(file, familyOf(probe.container));
    try {
      const { video } = await pickTracks(input, probe.container);
      const config = (await video.getDecoderConfig()) as VideoDecoderConfig;
      const canvas = new OffscreenCanvas(256, 32);
      const context = canvas.getContext("2d", {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      const numbers: number[] = [];
      const timestamps: number[] = [];
      await decodeVideoFrames(
        video,
        config,
        frameBounds(probe),
        { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
        (frame) => {
          context.drawImage(frame, 0, 0, 256, 32);
          const row = context.getImageData(0, 16, 256, 1).data;
          let number = 0;
          for (let block = 0; block < 8; block += 1) {
            number = number * 2 + ((row[(block * 32 + 16) * 4] as number) > 128 ? 1 : 0);
          }
          numbers.push(number);
          timestamps.push(frame.timestamp - probe.start);
        },
      );
      const tags = await input.getMetadataTags();
      const metadata: Record<string, string> = {};
      for (const key of ["title", "description", "artist", "comment"] as const) {
        const value = tags[key];
        if (typeof value === "string" && value !== "") metadata[key] = value;
      }
      if (tags.date) metadata["date"] = tags.date.toISOString().slice(0, 10);
      return {
        numbers,
        timestamps,
        metadata,
        container: probe.container,
        videoCodec: probe.video.codec,
        audioCodec: probe.audio?.codec ?? null,
        tracks: probe.tracks,
      };
    } finally {
      input.dispose();
    }
  },
});
