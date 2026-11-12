import { describe, expect, it } from "vitest";
import { ebmlFile, element, IDS, trackEntry } from "../../../test/builders/ebml.js";
import { ascii, box, elst, flatten, isoFile, trak, u32 } from "../../../test/builders/isobmff.js";
import { isVideoError, type VideoErrorCode } from "../../core/errors/video-error.js";
import { videoLimits } from "../../core/errors/video-limits.js";
import { frontCheck, packetCaps } from "./front-check.js";

const policy = videoLimits.resolve();
const blob = (bytes: Uint8Array) => new Blob([new Uint8Array(bytes)]);

async function failure(
  bytes: Uint8Array,
  overrides = {},
): Promise<{ code: VideoErrorCode; reason: unknown }> {
  try {
    await frontCheck(blob(bytes), videoLimits.resolve(overrides));
  } catch (error) {
    if (!isVideoError(error)) throw error;
    return {
      code: error.code,
      reason: (error.details as { reason?: unknown } | undefined)?.reason,
    };
  }
  throw new Error("expected the front check to fail");
}

const moov = (...tracks: Uint8Array[]) =>
  box("moov", [box("mvhd", new Uint8Array(100)), ...tracks]);
const mdat = box("mdat", new Uint8Array(32));

describe("the ISOBMFF front check", () => {
  it("identifies MP4 and QuickTime by their brand, and counts every track", async () => {
    const mp4 = await frontCheck(blob(isoFile("isom", moov(trak(), trak("mp4a")), mdat)), policy);
    expect(mp4).toMatchObject({ container: "mp4", family: "isobmff", tracks: 2 });
    expect(mp4.indexSize).toBe(moov(trak(), trak("mp4a")).length);
    const mov = await frontCheck(blob(isoFile("qt  ", moov(trak()))), policy);
    expect(mov.container).toBe("mov");
    const bare = await frontCheck(blob(flatten([box("wide"), mdat, moov(trak())])), policy);
    expect(bare.container).toBe("mov");
  });

  it("adds every moof to the index, and fails over maxIndexSize before mediabunny reads it", async () => {
    const fragments = Array.from({ length: 4 }, () => [box("moof", new Uint8Array(992)), mdat]);
    const file = isoFile("isom", moov(trak()), ...fragments.flat());
    const index = moov(trak()).length + 4 * 1_000;
    expect((await frontCheck(blob(file), policy)).indexSize).toBe(index);
    expect(await failure(file, { maxIndexSize: index - 1 })).toMatchObject({
      code: "INDEX_TOO_LARGE",
    });
    // An index far larger than the file can't pass either: the size is checked before reading it.
    expect(
      await failure(isoFile("isom", moov(trak(), box("free", new Uint8Array(2_000)))), {
        maxIndexSize: 1_000,
      }),
    ).toMatchObject({
      code: "INDEX_TOO_LARGE",
    });
  });

  it("allows one media edit, after at most one leading empty edit", async () => {
    for (const edits of [elst([0, 1]), elst([-1, 1], [512, 1])]) {
      await expect(
        frontCheck(blob(isoFile("isom", moov(trak("avc1", edits)))), policy),
      ).resolves.toBeDefined();
    }
  });

  it.each([
    ["two media edits", elst([0, 1], [100, 1])],
    ["a rate other than 1", elst([0, 2])],
    ["an empty edit after the media", elst([0, 1], [-1, 1])],
  ])("refuses an edit list with %s", async (_, edits) => {
    expect(await failure(isoFile("isom", moov(trak("avc1", edits))))).toEqual({
      code: "UNSUPPORTED_FORMAT",
      reason: "edit-list",
    });
  });

  it("refuses encrypted tracks and protection headers", async () => {
    for (const file of [
      isoFile("isom", moov(trak("encv"))),
      isoFile("isom", moov(trak("enca"))),
      isoFile("isom", moov(trak(), box("pssh", new Uint8Array(24)))),
    ]) {
      expect(await failure(file)).toEqual({ code: "UNSUPPORTED_FORMAT", reason: "encryption" });
    }
  });

  it.each([
    ["a box larger than the file", isoFile("isom", box("moov", [trak()], 10_000))],
    ["a box smaller than its header", isoFile("isom", box("moov", [], 4))],
    ["a child larger than its parent", isoFile("isom", box("moov", [box("trak", [], 500)]))],
    ["no moov", isoFile("isom", mdat)],
    ["two moov boxes", isoFile("isom", moov(trak()), moov(trak()))],
    ["no tracks", isoFile("isom", moov())],
    [
      "a 64-bit size beyond what's safe",
      flatten([box("ftyp", ascii("isom")), u32(1), ascii("mdat"), u32(0xffffffff, 0xffffffff)]),
    ],
    [
      "an elst whose entries overrun it",
      isoFile("isom", moov(trak("avc1", box("elst", [u32(0, 1_000)])))),
    ],
  ])("rejects %s as INVALID_VIDEO", async (_, file) => {
    expect((await failure(file)).code).toBe("INVALID_VIDEO");
  });

  it("stops after as many elements as the limits allow packets", async () => {
    const caps = packetCaps(videoLimits.resolve({ maxDuration: 1 }));
    const many = Array.from({ length: caps.video + caps.audio + 10_001 }, () => box("free"));
    expect(await failure(isoFile("isom", moov(trak()), ...many), { maxDuration: 1 })).toEqual({
      code: "INVALID_VIDEO",
      reason: "too-many-elements",
    });
  });
});

describe("the EBML front check", () => {
  const tracks = (...entries: Uint8Array[]) => element(IDS.TRACKS, entries);
  const cluster = (size?: number | "unknown") =>
    element(
      IDS.CLUSTER,
      [element(IDS.TIMECODE, Uint8Array.of(0)), element(IDS.SIMPLE_BLOCK, new Uint8Array(20))],
      size,
    );

  it("identifies WebM and Matroska by DocType, and counts every track", async () => {
    const webm = await frontCheck(
      blob(ebmlFile("webm", [tracks(trackEntry(), trackEntry()), cluster()])),
      policy,
    );
    expect(webm).toMatchObject({ container: "webm", family: "matroska", tracks: 2 });
    expect(
      (await frontCheck(blob(ebmlFile("matroska", [tracks(trackEntry())])), policy)).container,
    ).toBe("mkv");
  });

  it("walks a MediaRecorder file: an unknown-size Segment and unknown-size Clusters", async () => {
    const file = ebmlFile(
      "webm",
      [
        tracks(trackEntry()),
        cluster("unknown"),
        cluster("unknown"),
        element(IDS.CUES, new Uint8Array(10)),
      ],
      "unknown",
    );
    const checked = await frontCheck(blob(file), policy);
    expect(checked.tracks).toBe(1);
    expect(checked.indexSize).toBe(
      tracks(trackEntry()).length + element(IDS.CUES, new Uint8Array(10)).length,
    );
  });

  it("bounds the index: Tracks and Cues count, and fail over maxIndexSize", async () => {
    const file = ebmlFile("webm", [tracks(trackEntry()), element(IDS.CUES, new Uint8Array(5_000))]);
    expect(await failure(file, { maxIndexSize: 1_000 })).toMatchObject({ code: "INDEX_TOO_LARGE" });
  });

  it("refuses an unknown DocType, encrypted tracks, and anything else that isn't EBML", async () => {
    expect(await failure(ebmlFile("avi", [tracks(trackEntry())]))).toEqual({
      code: "UNSUPPORTED_FORMAT",
      reason: "doc-type",
    });
    expect(await failure(ebmlFile("webm", [tracks(trackEntry(true))]))).toEqual({
      code: "UNSUPPORTED_FORMAT",
      reason: "encryption",
    });
    expect(await failure(ascii("RIFF\0\0\0\0AVI LIST"))).toEqual({
      code: "UNSUPPORTED_FORMAT",
      reason: "signature",
    });
    expect(await failure(new Uint8Array(0))).toEqual({
      code: "UNSUPPORTED_FORMAT",
      reason: "signature",
    });
  });

  it.each([
    ["no Tracks", ebmlFile("webm", [cluster()])],
    ["Tracks with no entries", ebmlFile("webm", [tracks()])],
    [
      "an element larger than the Segment",
      ebmlFile("webm", [element(IDS.TRACKS, [trackEntry()], 9_999)]),
    ],
    [
      "an unknown size outside a Cluster",
      ebmlFile("webm", [element(IDS.TRACKS, [trackEntry()], "unknown")]),
    ],
    [
      "an invalid size length",
      flatten([
        element(IDS.EBML, [element(IDS.DOC_TYPE, ascii("webm"))]),
        Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x00),
      ]),
    ],
  ])("rejects %s as INVALID_VIDEO", async (_, file) => {
    expect((await failure(file)).code).toBe("INVALID_VIDEO");
  });
});
