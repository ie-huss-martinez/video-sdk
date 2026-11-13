import { createWorkerClient } from "@hussmartinez/sdk-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DECODE_QUEUE,
  MAX_STALLED_DECODE_QUEUE,
} from "../../src/adapters/mediabunny/video-decoder.js";
import { isVideoError, VideoError } from "../../src/index.js";
import landscapeVp8 from "../fixtures/video/landscape-vp8.webm?url";
import type { DecodeContract, DecodeRequest } from "./decode.worker.js";

// Decoding frames in a worker (docs/adr/0001, docs/adr/0002), on VP8, which
// every engine decodes. After every call, whether it succeeded, failed, or
// was cancelled, the worker must hold no open frame.
describe("decoding video frames in a worker", () => {
  const client = createWorkerClient<DecodeContract>({
    createWorker: () =>
      new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" }),
    errorClasses: { VideoError },
  });
  const file = async () => (await fetch(landscapeVp8)).blob();
  const decode = async (request: Omit<DecodeRequest, "file">) =>
    client.call("decode", { file: await file(), ...request });
  const failure = async (request: Omit<DecodeRequest, "file">) => {
    try {
      await decode(request);
    } catch (error) {
      return error;
    }
    throw new Error("expected the decode to fail");
  };

  beforeEach(async () => {
    await client.call("resetLedger", undefined);
  });

  afterEach(async () => {
    const ledger = await client.call("ledger", undefined);
    expect(ledger.open, "frames left open").toBe(0);
    // The queue grows past its bound only by one packet per stall, and never past the hard cap.
    expect(ledger.peakDecodeQueue).toBeLessThanOrEqual(
      Math.min(MAX_DECODE_QUEUE + ledger.stalls, MAX_STALLED_DECODE_QUEUE),
    );
  });

  it("decodes every frame, in presentation order, at the probe's size", async () => {
    const { timestamps, sizes } = await decode({});
    expect(timestamps).toHaveLength(60);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    expect(new Set(sizes.map(([w, h]) => `${w}×${h}`))).toEqual(new Set(["1280×720"]));
  });

  it("delivers only the frames of a range, starting from the key packet before it", async () => {
    // Half a second from 0.5 s, at 30 fps: 15 frames, though decoding starts at 0.
    const { timestamps } = await decode({ from: 500_000, to: 1_000_000 });
    expect(timestamps).toHaveLength(15);
    expect(timestamps.every((t) => t >= 500_000 && t < 1_000_000)).toBe(true);
  });

  it("gives a decoder that holds more packets than that before any output more, rather than deadlocking", async () => {
    // As Firefox does with frame-threaded VP8 on a machine with many cores.
    const { timestamps } = await decode({ lag: 12 });
    expect(timestamps).toHaveLength(60);
    expect((await client.call("ledger", undefined)).stalls).toBeGreaterThanOrEqual(4);
  });

  it("fails fast with DECODE_FAILED when a decoder holds the hard cap without output", async () => {
    const started = performance.now();
    const error = await failure({ lag: MAX_STALLED_DECODE_QUEUE + 8 });
    expect(isVideoError(error, "DECODE_FAILED")).toBe(true);
    expect((error as VideoError).details).toMatchObject({ reason: "stalled" });
    // 24 stalls of 50 ms each, not the processing time's minutes.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("stops after a limit", async () => {
    expect((await decode({ limit: 1 })).timestamps).toHaveLength(1);
  });

  it("passes on what the consumer throws, and closes everything", async () => {
    const error = await failure({ throwAt: 5 });
    expect(error).toMatchObject({ message: expect.stringContaining("the consumer failed") });
  });

  it("stops when cancelled, with ABORTED, and closes everything", async () => {
    expect(isVideoError(await failure({ abortAt: 10 }), "ABORTED")).toBe(true);
  });

  it("closes a frame the decoder delivers after it's closed, as Firefox can after a cancel", async () => {
    expect(isVideoError(await failure({ abortAt: 10, lateOutput: true }), "ABORTED")).toBe(true);
    // The late frame arrives on a task after the call settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("refuses frames larger than the probe allows, with INVALID_VIDEO", async () => {
    const error = await failure({ shrinkBounds: true });
    expect(isVideoError(error, "INVALID_VIDEO")).toBe(true);
    expect((error as VideoError).details).toMatchObject({ reason: "frame-size" });
  });

  it("maps a browser that fails to decode to DECODE_FAILED, and closes everything", async () => {
    // VP8 packets fed to a VP9 decoder.
    const error = await failure({ codec: "vp09.00.10.08" });
    expect(isVideoError(error, "DECODE_FAILED")).toBe(true);
  });
});
