import { createWorkerClient } from "@hussmartinez/sdk-core";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_DECODE_QUEUE } from "../../src/adapters/mediabunny/video-decoder.js";
import { isVideoError, VideoError } from "../../src/index.js";
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
  const decode = async (request: Omit<AudioDecodeRequest, "file">) =>
    client.call("decode", { file: await (await fetch(landscapeVp8)).blob(), ...request });
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
