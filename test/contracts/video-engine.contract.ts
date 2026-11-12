import { describe, expect, it } from "vitest";
import { isVideoError, type VideoEngine, videoLimits } from "../../src/index.js";
import { aborted, rejection } from "./helpers.js";

/**
 * What an engine's contract test needs: a way to create the engine and
 * files to read. The SDK's adapter supplies generated MP4 and WebM files;
 * the fakes supply fake ones.
 */
export interface VideoEngineHarness {
  createEngine(): VideoEngine;
  /** 1280 × 720 at 30 frames per second, 2 seconds long, with 48 kHz stereo audio. */
  landscape(): Promise<Blob>;
  /** The same, stored 1280 × 720 with a container rotation of 90°. */
  rotated(): Promise<Blob>;
  /** 1280 × 720 at 30 frames per second, 2 seconds long, with no audio track. */
  silent(): Promise<Blob>;
  /** 2 seconds of packets, whose header claims 1 second. */
  lyingHeader(): Promise<Blob>;
  /** A file in a recognised container that's malformed. */
  malformed(): Promise<Blob>;
  /** A file in a container the engine doesn't recognise. */
  unknown(): Promise<Blob>;
  /** How far a probe's frame rate (per second) and duration (µs) may be from the fixture's. */
  readonly tolerance: { readonly frameRate: number; readonly duration: number };
}

/**
 * The behaviour every {@link VideoEngine} must have (ADR 0001, ADR 0004,
 * ADR 0008). Adapters run it with their own harness.
 */
export function describeVideoEngineContract(name: string, harness: VideoEngineHarness): void {
  describe(`${name}: the VideoEngine contract`, () => {
    const near = (actual: number, expected: number, tolerance: number) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

    it("probes a file's tracks, size, rate and length without opening it", async () => {
      const engine = harness.createEngine();
      const probe = await engine.probe(await harness.landscape());
      expect(probe.video).toMatchObject({ displayWidth: 1280, displayHeight: 720, rotation: 0 });
      expect(probe.video.codedWidth).toBeGreaterThanOrEqual(1280);
      expect(probe.video.codedHeight).toBeGreaterThanOrEqual(720);
      near(probe.video.frameRate, 30, harness.tolerance.frameRate);
      near(probe.duration, 2_000_000, harness.tolerance.duration);
      expect(probe.audio).toMatchObject({ sampleRate: 48_000, channels: 2 });
      expect(probe.tracks).toBeGreaterThanOrEqual(2);
      for (const value of [
        probe.indexSize,
        probe.peakBitrate,
        probe.maxPacketSize,
        probe.video.packets,
      ]) {
        expect(value).toBeGreaterThan(0);
      }
      await engine.destroy();
    });

    it("reports the container's rotation, and no audio for a silent file", async () => {
      const engine = harness.createEngine();
      const rotated = await engine.probe(await harness.rotated());
      expect(rotated.video).toMatchObject({ displayWidth: 1280, displayHeight: 720, rotation: 90 });
      expect((await engine.probe(await harness.silent())).audio).toBeNull();
      await engine.destroy();
    });

    it("never lets a header shorten a file below its packets", async () => {
      const engine = harness.createEngine();
      const probe = await engine.probe(await harness.lyingHeader());
      expect(probe.duration).toBeGreaterThanOrEqual(2_000_000 - harness.tolerance.duration);
      await engine.destroy();
    });

    it("rejects a malformed file with INVALID_VIDEO, and an unknown one with UNSUPPORTED_FORMAT", async () => {
      const engine = harness.createEngine();
      expect(
        isVideoError(await rejection(engine.probe(await harness.malformed())), "INVALID_VIDEO"),
      ).toBe(true);
      expect(
        isVideoError(await rejection(engine.probe(await harness.unknown())), "UNSUPPORTED_FORMAT"),
      ).toBe(true);
      await engine.destroy();
    });

    it("applies the policy's file-size and index limits itself", async () => {
      const engine = harness.createEngine();
      const file = await harness.landscape();
      const tiny = (limit: "maxFileSize" | "maxIndexSize") => videoLimits.resolve({ [limit]: 10 });
      expect(
        isVideoError(
          await rejection(engine.probe(file, { filePolicy: tiny("maxFileSize") })),
          "FILE_TOO_LARGE",
        ),
      ).toBe(true);
      expect(
        isVideoError(
          await rejection(engine.probe(file, { filePolicy: tiny("maxIndexSize") })),
          "INDEX_TOO_LARGE",
        ),
      ).toBe(true);
      await engine.destroy();
    });

    it("rejects a cancelled call with ABORTED", async () => {
      const engine = harness.createEngine();
      const file = await harness.landscape();
      expect(
        isVideoError(await rejection(engine.probe(file, { signal: aborted() })), "ABORTED"),
      ).toBe(true);
      const probe = await engine.probe(file);
      expect(
        isVideoError(
          await rejection(engine.open("a", file, probe, { signal: aborted() })),
          "ABORTED",
        ),
      ).toBe(true);
      await engine.destroy();
    });

    it("opens a probed file once per id, and opens it again after closing it", async () => {
      const engine = harness.createEngine();
      const file = await harness.landscape();
      const probe = await engine.probe(file);
      const info = await engine.open("a", file, probe);
      expect(info).toMatchObject({
        id: "a",
        duration: probe.duration,
        video: { width: 1280, height: 720, rotation: 0 },
        audio: { sampleRate: 48_000, channels: 2 },
      });
      expect(await rejection(engine.open("a", file, probe))).toBeInstanceOf(TypeError);
      await engine.close("a");
      await engine.close("never-opened");
      await expect(engine.open("a", file, probe)).resolves.toMatchObject({ id: "a" });
      await engine.destroy();
    });

    it("rejects calls after destroy", async () => {
      const engine = harness.createEngine();
      const file = await harness.landscape();
      await engine.destroy();
      await expect(engine.probe(file)).rejects.toThrow();
    });
  });
}
