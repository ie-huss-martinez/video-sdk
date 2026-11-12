import { createWorkerClient } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { isVideoError, VideoError, videoLimits } from "../../src/index.js";
import landscapeMkv from "../fixtures/video/landscape.mkv?url";
import landscapeMp4 from "../fixtures/video/landscape.mp4?url";
import landscapeWebm from "../fixtures/video/landscape.webm?url";
import rotatedMov from "../fixtures/video/rotated.mov?url";
import tinyMp4 from "../fixtures/video/tiny.mp4?url";
import type { GuardedContract } from "./guarded.worker.js";

// ADR 0001 and ADR 0028: mediabunny never fetches, never starts a worker of
// its own and never makes a blob URL. Every fixture is probed in a worker
// where each of those throws and is recorded.
describe("the media worker with guarded globals", () => {
  it("probes every fixture, and malformed ones, without reaching for the network or a worker", async () => {
    const client = createWorkerClient<GuardedContract>({
      createWorker: () =>
        new Worker(new URL("./guarded.worker.ts", import.meta.url), { type: "module" }),
      errorClasses: { VideoError },
    });
    const limits = videoLimits.resolve().limits;
    for (const url of [landscapeMp4, landscapeWebm, landscapeMkv, rotatedMov]) {
      const file = await (await fetch(url)).blob();
      const probe = await client.call("probe", { file, limits });
      expect(probe.video.packets, url).toBe(60);
    }
    const tiny = await (await fetch(tinyMp4)).blob();
    for (const broken of [tiny.slice(0, 1_000), tiny.slice(0, 3_000), new Blob(["not a video"])]) {
      let error: unknown;
      try {
        await client.call("probe", { file: broken, limits });
      } catch (caught) {
        error = caught;
      }
      expect(isVideoError(error)).toBe(true);
    }
    expect(await client.call("forbiddenCalls", undefined)).toEqual([]);
    client.destroy();
  });

  it("would notice: the guard records and throws on every guarded API", async () => {
    const client = createWorkerClient<GuardedContract>({
      createWorker: () =>
        new Worker(new URL("./guarded.worker.ts", import.meta.url), { type: "module" }),
      errorClasses: { VideoError },
    });
    expect(await client.call("tripGuard", undefined)).toBe(7);
    expect(await client.call("forbiddenCalls", undefined)).toEqual([
      "fetch",
      "XMLHttpRequest",
      "importScripts",
      "Worker",
      "WebSocket",
      "EventSource",
      "URL.createObjectURL",
    ]);
    client.destroy();
  });
});
