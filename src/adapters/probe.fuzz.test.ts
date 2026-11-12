import { readFile } from "node:fs/promises";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ebmlFile, element, IDS, trackEntry } from "../../test/builders/ebml.js";
import { ascii, box, isoFile, trak, u32 } from "../../test/builders/isobmff.js";
import { isVideoError, type VideoErrorCode } from "../core/errors/video-error.js";
import { videoLimits } from "../core/errors/video-limits.js";
import type { VideoProbe } from "../core/model/source.js";
import { probeFile } from "./probe.js";

// The probe is hostile-input code (ADR 0001): whatever bytes it's given, it
// settles quickly with a probe or one of these codes. It never hangs, throws
// anything else, or lets mediabunny's own errors through.
const ALLOWED: ReadonlySet<VideoErrorCode> = new Set([
  "INVALID_VIDEO",
  "UNSUPPORTED_FORMAT",
  "UNSUPPORTED_CODEC",
  "INDEX_TOO_LARGE",
  "FRAME_RATE_TOO_HIGH",
  "DURATION_TOO_LONG",
]);
/** How long one probe of a small file may take. */
const SETTLE_MS = 2_000;
const policy = videoLimits.resolve();

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`test/fixtures/video/${name}`));
}

function expectSane(probe: VideoProbe): void {
  expect(probe.duration).toBeGreaterThanOrEqual(0);
  expect(probe.tracks).toBeGreaterThanOrEqual(1);
  expect(probe.video.packets).toBeGreaterThanOrEqual(1);
  expect(probe.video.frameRate).toBeGreaterThanOrEqual(1);
  expect(Number.isSafeInteger(probe.indexSize)).toBe(true);
}

/** Probes the bytes and checks it settled in time, with a sane probe or an allowed code. */
async function settles(bytes: Uint8Array, label: string): Promise<void> {
  const started = performance.now();
  try {
    expectSane(await probeFile(new Blob([new Uint8Array(bytes)]), policy));
  } catch (error) {
    if (!isVideoError(error) || !ALLOWED.has(error.code)) {
      throw new Error(`${label}: unexpected failure`, { cause: error });
    }
  }
  expect(performance.now() - started, label).toBeLessThan(SETTLE_MS);
}

describe("the probe against truncated files", () => {
  it.each(["tiny.mp4", "tiny.webm"])(
    "settles for %s cut at every byte offset",
    async (name) => {
      const bytes = await fixture(name);
      for (let length = 0; length < bytes.length; length += 1) {
        await settles(bytes.subarray(0, length), `${name} cut at ${length}`);
      }
    },
    120_000,
  );
});

describe("the probe against mutated files", () => {
  /** Overwrites a few bytes, weighted towards the start, where the structure is. */
  const mutations = (length: number) =>
    fc.array(
      fc.record({
        at: fc.oneof(fc.nat(Math.min(length, 4_096) - 1), fc.nat(length - 1)),
        value: fc.oneof(fc.constantFrom(0x00, 0x01, 0x7f, 0x80, 0xff), fc.nat(255)),
      }),
      { minLength: 1, maxLength: 16 },
    );

  it.each([
    "landscape.mp4",
    "landscape.webm",
    "landscape.mkv",
    "fragmented.mp4",
    "rotated.mov",
    "tiny.mp4",
    "tiny.webm",
  ])(
    "settles for %s with random bytes overwritten",
    async (name) => {
      const original = await fixture(name);
      await fc.assert(
        fc.asyncProperty(mutations(original.length), async (changes) => {
          const bytes = original.slice();
          for (const { at, value } of changes) bytes[at] = value;
          await settles(bytes, `${name} mutated`);
        }),
        { numRuns: 120 },
      );
    },
    120_000,
  );
});

describe("the probe against garbage", () => {
  it("settles for random bytes, alone or behind a valid signature", async () => {
    const prefix = fc.constantFrom(
      new Uint8Array(0),
      box("ftyp", [ascii("isom"), u32(0)]),
      element(IDS.EBML, [element(IDS.DOC_TYPE, ascii("webm"))]),
    );
    await fc.assert(
      fc.asyncProperty(prefix, fc.uint8Array({ maxLength: 2_048 }), async (head, tail) => {
        const bytes = new Uint8Array(head.length + tail.length);
        bytes.set(head);
        bytes.set(tail, head.length);
        await settles(bytes, "garbage");
      }),
      { numRuns: 400 },
    );
  }, 120_000);

  it("settles for hand-built box and element trees with wrong sizes", async () => {
    const isoTree = fc
      .array(
        fc.record({
          type: fc.constantFrom(
            "moov",
            "trak",
            "moof",
            "mdat",
            "free",
            "edts",
            "elst",
            "mdia",
            "pssh",
            "uuid",
          ),
          size: fc.option(fc.oneof(fc.constantFrom(0, 1, 7, 8, 0xffffffff), fc.nat(100_000)), {
            nil: undefined,
          }),
          body: fc.uint8Array({ maxLength: 64 }),
        }),
        { maxLength: 8 },
      )
      .map((boxes) =>
        isoFile(
          "isom",
          box("moov", [trak()]),
          ...boxes.map(({ type, size, body }) => box(type, body, size)),
        ),
      );
    const ebmlTree = fc
      .array(
        fc.record({
          id: fc.constantFrom(
            IDS.TRACKS,
            IDS.CUES,
            IDS.CLUSTER,
            IDS.INFO,
            IDS.SIMPLE_BLOCK,
            0xec,
            0x1f,
          ),
          size: fc.option(fc.oneof(fc.constant("unknown" as const), fc.nat(100_000)), {
            nil: undefined,
          }),
          body: fc.uint8Array({ maxLength: 64 }),
        }),
        { maxLength: 8 },
      )
      .map((elements) =>
        ebmlFile("webm", [
          element(IDS.TRACKS, [trackEntry()]),
          ...elements.map(({ id, size, body }) => element(id, body, size)),
        ]),
      );
    await fc.assert(
      fc.asyncProperty(fc.oneof(isoTree, ebmlTree), async (bytes) => {
        await settles(bytes, "tree");
      }),
      { numRuns: 400 },
    );
  }, 120_000);
});
