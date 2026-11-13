import { describe, expect, it } from "vitest";
import { isVideoError } from "../errors/video-error.js";
import { clipEnd, createPlan, IDENTITY_TRANSFORM, NO_FADE } from "../model/plan.js";
import type { VideoSourceInfo } from "../model/source.js";
import {
  readVideoPlanDocument,
  toVideoPlanDocument,
  VIDEO_PLAN_FORMAT,
  videoPlanDocumentSource,
} from "./plan-document.js";

// The plan document's reader and writer (sdk-core ADR 0045). The vectors in
// conformance/ cover every outcome; these cover what they can't show.

const RATE = { num: 25, den: 1 };
const info: VideoSourceInfo = {
  id: "s1",
  container: "mp4",
  duration: 4_000_000,
  video: { codec: "avc1.64001f", width: 1920, height: 1080, rotation: 90, frameRate: 25 },
  audio: null,
};
const plan = {
  ...createPlan({ width: 1080, height: 1920, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
  clips: [
    {
      key: "a",
      source: "s1",
      start: 0,
      end: clipEnd(0, 50, RATE),
      volumeDb: 0,
      muted: false,
      fadeIn: NO_FADE,
      fadeOut: NO_FADE,
      transform: IDENTITY_TRANSFORM,
    },
  ],
};

describe("plan documents", () => {
  it("round-trip a plan over a session's sources, as plain JSON", () => {
    const sources = new Map([["s1", videoPlanDocumentSource(info)]]);
    const document = toVideoPlanDocument(plan, sources);
    expect(document.format).toBe(VIDEO_PLAN_FORMAT);
    expect(document.sources).toEqual({
      s1: { duration: 4_000_000, width: 1920, height: 1080, rotation: 90 },
    });
    const read = readVideoPlanDocument(JSON.parse(JSON.stringify(document)));
    expect(read.plan).toEqual(plan);
    expect([...read.sources]).toEqual([...sources]);
  });

  it("won't write a document that leaves out a clip's source", () => {
    expect(() => toVideoPlanDocument(plan, new Map())).toThrow(TypeError);
  });

  it("refuses with the format and a reason, never a message to compare", () => {
    let error: unknown;
    try {
      readVideoPlanDocument({ format: VIDEO_PLAN_FORMAT, version: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(isVideoError(error, "INVALID_DOCUMENT")).toBe(true);
    expect((error as { details: unknown }).details).toEqual({
      format: VIDEO_PLAN_FORMAT,
      reason: "malformed-document",
    });
  });

  it("doesn't take a clip's source from the prototype", () => {
    // A source id that a plain object would find on Object.prototype.
    const document = JSON.parse(
      JSON.stringify(toVideoPlanDocument(plan, new Map([["s1", videoPlanDocumentSource(info)]]))),
    );
    document.clips[0].source = "hasOwnProperty";
    expect(() => readVideoPlanDocument(document)).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "unknown-source" }) }),
    );
  });
});
