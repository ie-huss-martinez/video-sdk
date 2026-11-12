import { createWorkerClient } from "@hussmartinez/sdk-core";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DECODE_QUEUE } from "../../src/adapters/mediabunny/video-decoder.js";
import { isVideoError, VideoError } from "../../src/index.js";
import landscapeMp4 from "../fixtures/video/landscape.mp4?url";
import landscapeVp8 from "../fixtures/video/landscape-vp8.webm?url";
import type { AudioDecodeContract, AudioDecodeRequest } from "./audio-decode.worker.js";

// Decoding audio in a worker (docs/adr/0002), on Opus, which every engine
// decodes. After every call, whatever its outcome, no AudioData is open.
describe("decoding audio in a worker", () => {
  const client = createWorkerClient<AudioDecodeContract>({
    createWorker: () =>
      new Worker(new URL("./audio-decode.worker.ts", import.meta.url), { type: "module" }),
    errorClasses: { VideoError },
  });
  const decode = async (request: Omit<AudioDecodeRequest, "file">, url = landscapeVp8) =>
    client.call("decode", { file: await (await fetch(url)).blob(), ...request });
  const failure = async (request: Omit<AudioDecodeRequest, "file">) => {
    try {
      await decode(request);
    } catch (error) {
      return error;
    }
    throw new Error("expected the decode to fail");
  };

  afterEach(async () => {
    const ledger = await client.call("ledger", undefined);
    expect(ledger.open, "audio left open").toBe(0);
    expect(ledger.peakDecodeQueue).toBeLessThanOrEqual(MAX_DECODE_QUEUE);
  });

  it("decodes the whole track: two seconds at 48 kHz", async () => {
    const { frames } = await decode({});
    // Opus's pre-skip and padding can shift the count by a frame either way.
    expect(Math.abs(frames - 96_000)).toBeLessThanOrEqual(5_760);
  });

  it.for([
    ["Opus in WebM", landscapeVp8, "opus"],
    ["AAC in MP4", landscapeMp4, "mp4a.40.2"],
  ] as const)(
    "places each chunk where the stream puts it, from its first packet: %s",
    async ([, url, codec], context) => {
      const config = { codec, sampleRate: 48_000, numberOfChannels: 2 };
      if (!(await AudioDecoder.isConfigSupported(config)).supported) {
        context.skip(`this browser doesn't decode ${codec} here`);
      }
      const { placed, firstPacket } = await decode({}, url);
      expect(placed.length).toBeGreaterThan(10);
      // The first chunk where its packet is, within one chunk; WebKit's own
      // timestamps for AAC are seconds away.
      const [first] = placed;
      expect(Math.abs((first?.[0] as number) - firstPacket)).toBeLessThanOrEqual(
        first?.[1] as number,
      );
      // Then end to end, within a microsecond. Opus's first chunk is short by
      // its pre-skip, which the decoder drops, so the count starts after it.
      for (let index = 2; index < placed.length; index += 1) {
        const [time] = placed[index] as [number, number];
        const [before, length] = placed[index - 1] as [number, number];
        expect(Math.abs(time - (before + length)), `chunk ${index}`).toBeLessThanOrEqual(1);
      }
    },
  );

  it("delivers only the chunks of a range", async () => {
    const { first, frames } = await decode({ from: 1_000_000, to: 1_500_000 });
    expect(first).toBeLessThan(1_000_000 + 120_000);
    expect(frames).toBeLessThan(48_000);
  });

  it("passes on what the consumer throws, and closes everything", async () => {
    expect(await failure({ throwAt: 3 })).toMatchObject({
      message: expect.stringContaining("the consumer failed"),
    });
  });

  it("stops when cancelled, with ABORTED", async () => {
    expect(isVideoError(await failure({ abortAt: 5 }), "ABORTED")).toBe(true);
  });

  it("refuses chunks that don't match the track, with INVALID_VIDEO", async () => {
    const error = await failure({ wrongChannels: true });
    // A decoder may also refuse the mismatched configuration outright.
    expect(isVideoError(error, "INVALID_VIDEO") || isVideoError(error, "DECODE_FAILED")).toBe(true);
  });

  it("maps a browser that fails to decode to DECODE_FAILED", async () => {
    // Vorbis can't decode without its setup headers, which a description
    // carries; every engine refuses it.
    expect(isVideoError(await failure({ codec: "vorbis" }), "DECODE_FAILED")).toBe(true);
  });
});
