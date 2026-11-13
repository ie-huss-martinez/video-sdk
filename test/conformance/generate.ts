import type {
  ConformanceCase,
  ConformanceFile,
} from "@hussmartinez/sdk-config/testing/conformance";
import fc from "fast-check";
import {
  clipEnd,
  type FrameRate,
  toVideoPlanDocument,
  type VideoClip,
  type VideoPlanDocumentSource,
  videoPlanDocumentSource,
} from "../../src/index.js";
import { clip, commandFor, planArb, SOURCES } from "../arbitraries/video-plan.js";
import { applyToDocument, readAndWrite } from "./run.js";

/**
 * Writes the conformance cases (sdk-core ADR 0045): hand-written cases for
 * every outcome a port must reproduce, and cases generated from the
 * reducer's property-test generators with a fixed seed. The files in
 * conformance/ are this module's output, checked in; `pnpm conformance:update`
 * rewrites them, and the tests fail when they're out of date.
 */

/** The seed of the generated cases. Changing it, or fast-check's version, rewrites them. */
const SEED = 45;
/** How many generated commands that apply, and of each refusal, the file keeps. */
const GENERATED_APPLIED = 60;
const GENERATED_PER_REFUSAL = 2;
/** How many generated documents the plan file keeps. */
const GENERATED_PLANS = 20;

const NTSC: FrameRate = { num: 30_000, den: 1_001 };

/** The generators' sources, as a document records them. */
const generatedSources = new Map(SOURCES.map((info) => [info.id, videoPlanDocumentSource(info)]));

/** The value as JSON carries it: what a port reads from the file. */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const BASE_SOURCES = new Map<string, VideoPlanDocumentSource>([
  ["s1", { duration: 10_000_000, width: 1920, height: 1080, rotation: 0 }],
  ["s2", { duration: 7_300_000, width: 1280, height: 720, rotation: 90 }],
]);

/**
 * Two clips at 30000/1001 frames per second: `a` plays s1's first 30
 * frames, timeline frames 0 to 30, and `b` 60 frames of s2 from 1.001 s,
 * timeline frames 30 to 90, with a volume, fades and a transform.
 */
const BASE = toVideoPlanDocument(
  {
    output: { width: 640, height: 360, frameRate: NTSC, sampleRate: 48_000, channels: 2 },
    clips: [
      clip("a", "s1", 0, 30),
      {
        ...clip("b", "s2", 1_001_000, 60),
        volumeDb: -3.5,
        fadeIn: { duration: 200_000, curve: "equalPower" },
        fadeOut: { duration: 300_000, curve: "linear" },
        transform: { rotation: 90, crop: { x: 0, y: 0, width: 640, height: 360 }, fit: "cover" },
      },
    ],
    metadata: { title: "Take 1", description: "", artist: "", date: "", comment: "" },
  },
  BASE_SOURCES,
);

/**
 * A plan whose source ids and clip keys are the names of `Object.prototype`'s
 * properties, built from JSON text, so `__proto__` is an own field as any
 * JSON parser makes it. Readers that keep ids in plain objects, in any
 * language, must still treat them as data (sdk-core ADR 0045).
 */
const PROTOTYPE_NAMED = JSON.parse(
  JSON.stringify({
    ...BASE,
    sources: Object.fromEntries(
      ["PROTO", "constructor", "toString"].map((name) => [
        name,
        { duration: 2_000_000, width: 640, height: 360, rotation: 0 },
      ]),
    ),
    clips: ["PROTO", "constructor", "toString"].map((name) => clip(name, name, 0, 10)),
  }).replaceAll('"PROTO"', '"__proto__"'),
) as typeof BASE;

type Outcome = { readonly ok: true } | { readonly code: string; readonly reason: string };

/**
 * A case whose expected result is what the runner gives. For a hand-written
 * case, `outcome` is what the case is meant to show, and a runner that
 * disagrees fails here, before any file is written.
 */
function make(
  name: string,
  input: unknown,
  run: (input: never) => unknown,
  outcome?: Outcome,
): ConformanceCase {
  const json = asJson(input);
  let expected: unknown;
  try {
    expected = asJson(run(json as never));
  } catch (error) {
    const { code, details } = error as { code?: string; details?: { reason?: string } };
    if (typeof code !== "string" || typeof details?.reason !== "string") throw error;
    expected = { error: { code, reason: details.reason } };
  }
  if (outcome) {
    const got = (expected as { error?: Outcome }).error ?? { ok: true };
    if (JSON.stringify(got) !== JSON.stringify(outcome)) {
      throw new Error(
        `Case "${name}" gave ${JSON.stringify(got)}, not ${JSON.stringify(outcome)}.`,
      );
    }
  }
  return { name, input: json, expected };
}

const applied: Outcome = { ok: true };
const refused = (reason: string, code = "INVALID_COMMAND"): Outcome => ({ code, reason });
const invalidDocument = (reason: string) => refused(reason, "INVALID_DOCUMENT");

/** A clip for s1, from source frame 0, `frames` long, with any changes. */
const newClip = (key: string, frames: number, extra: Partial<VideoClip> = {}) => ({
  ...clip(key, "s1", 0, frames),
  ...extra,
});

/** `hm-video-commands`: a user-level command applied to a plan document. */
export function commandCases(): ConformanceFile {
  const on = (command: unknown, plan: unknown = BASE) => ({ plan, command });
  const handWritten: [string, unknown, Outcome][] = [
    [
      "inserts a clip at the plan's end",
      on({ type: "video.insertClips", at: 90, clips: [newClip("c", 10)] }),
      applied,
    ],
    [
      "inserts clips at the plan's start",
      on({ type: "video.insertClips", at: 0, clips: [newClip("c", 10), newClip("d", 5)] }),
      applied,
    ],
    ["removes a clip", on({ type: "video.removeClips", keys: ["a"] }), applied],
    [
      "removes every clip, leaving an empty plan",
      on({ type: "video.removeClips", keys: ["b", "a"] }),
      applied,
    ],
    [
      "deletes a range across clips, trimming both",
      on({ type: "video.deleteRange", start: 20, end: 40, keys: [] }),
      applied,
    ],
    [
      "deletes a range inside one clip, splitting it, each part keeping the fade of its own edge",
      on({ type: "video.deleteRange", start: 40, end: 50, keys: ["b2"] }),
      applied,
    ],
    [
      "trims a clip to another range on the grid",
      on({ type: "video.trimClip", key: "a", start: 1_001_000, end: clipEnd(1_001_000, 15, NTSC) }),
      applied,
    ],
    [
      "trims a clip shorter than its fades, shortening them",
      on({ type: "video.trimClip", key: "b", start: 1_001_000, end: clipEnd(1_001_000, 6, NTSC) }),
      applied,
    ],
    [
      "splits a clip, the second part taking the new key and the fade out",
      on({ type: "video.splitClip", key: "b", at: 60, newKey: "b2" }),
      applied,
    ],
    ["moves a clip after the other", on({ type: "video.moveClips", keys: ["a"], to: 60 }), applied],
    [
      "sets clips' volume",
      on({ type: "video.setVolume", keys: ["a", "b"], volumeDb: -6.25 }),
      applied,
    ],
    ["mutes a clip", on({ type: "video.setMuted", keys: ["b"], muted: true }), applied],
    [
      "sets a fade out",
      on({ type: "video.setFade", key: "a", edge: "out", duration: 500_000, curve: "equalPower" }),
      applied,
    ],
    [
      "rotates and crops a clip, the crop in the picture as it's shown",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: {
          rotation: 270,
          crop: { x: 10, y: 20, width: 100, height: 1_800 },
          fit: "cover",
        },
      }),
      applied,
    ],
    [
      "sets another frame rate, moving every clip's end to the new grid",
      on({
        type: "video.setOutput",
        output: {
          width: 1280,
          height: 720,
          frameRate: { num: 25, den: 1 },
          sampleRate: 44_100,
          channels: 1,
        },
      }),
      applied,
    ],
    [
      "sets a metadata field",
      on({ type: "video.setMetadata", field: "title", value: "Holiday" }),
      applied,
    ],
    [
      "treats __proto__, constructor and toString as ordinary clip keys",
      on({ type: "video.removeClips", keys: ["__proto__", "toString"] }, PROTOTYPE_NAMED),
      applied,
    ],
    [
      "treats __proto__, constructor and toString as ordinary source ids",
      on(
        {
          type: "video.insertClips",
          at: 30,
          clips: [{ ...clip("hasOwnProperty", "constructor", 0, 5) }],
        },
        PROTOTYPE_NAMED,
      ),
      applied,
    ],
    [
      "refuses an unknown field",
      on({ type: "video.removeClips", keys: ["a"], force: true }),
      refused("malformed-command"),
    ],
    [
      "refuses a fractional frame",
      on({ type: "video.splitClip", key: "b", at: 60.5, newKey: "b2" }),
      refused("malformed-command"),
    ],
    ["refuses an unknown command", on({ type: "video.nope" }), refused("unknown-command")],
    ["refuses removing no clips", on({ type: "video.removeClips", keys: [] }), refused("no-clips")],
    [
      "refuses naming a clip twice",
      on({ type: "video.removeClips", keys: ["a", "a"] }),
      refused("duplicate-key"),
    ],
    [
      "refuses a key that's taken",
      on({ type: "video.insertClips", at: 90, clips: [newClip("a", 10)] }),
      refused("key-taken"),
    ],
    [
      "refuses an unknown clip",
      on({ type: "video.removeClips", keys: ["z"] }),
      refused("unknown-clip"),
    ],
    [
      "refuses inserting where no clip starts or ends",
      on({ type: "video.insertClips", at: 10, clips: [newClip("c", 10)] }),
      refused("not-a-boundary"),
    ],
    [
      "refuses an empty range",
      on({ type: "video.deleteRange", start: 10, end: 10, keys: [] }),
      refused("empty-range"),
    ],
    [
      "refuses a range past the plan's end",
      on({ type: "video.deleteRange", start: 10, end: 200, keys: [] }),
      refused("frame-outside-plan"),
    ],
    [
      "refuses a split at a clip's edge",
      on({ type: "video.splitClip", key: "a", at: 30, newKey: "a2" }),
      refused("not-inside-clip"),
    ],
    [
      "refuses deleting inside a clip without a key for its second part",
      on({ type: "video.deleteRange", start: 5, end: 10, keys: [] }),
      refused("new-key-required"),
    ],
    [
      "refuses a key where nothing is cut in two",
      on({ type: "video.deleteRange", start: 0, end: 30, keys: ["k"] }),
      refused("unexpected-key"),
    ],
    [
      "refuses a fade edge that isn't in or out",
      on({ type: "video.setFade", key: "a", edge: "middle", duration: 0, curve: "linear" }),
      refused("invalid-edge"),
    ],
    [
      "refuses an unknown metadata field",
      on({ type: "video.setMetadata", field: "location", value: "here" }),
      refused("unknown-metadata-field"),
    ],
    [
      "refuses metadata over 1,000 characters",
      on({ type: "video.setMetadata", field: "title", value: "x".repeat(1_001) }),
      refused("metadata-too-long"),
    ],
    [
      "refuses a new clip without a key",
      on({ type: "video.insertClips", at: 90, clips: [newClip("", 10)] }),
      refused("missing-key"),
    ],
    [
      "refuses a clip from a negative microsecond",
      on({ type: "video.insertClips", at: 90, clips: [newClip("c", 10, { start: -1 })] }),
      refused("invalid-range"),
    ],
    [
      "refuses a clip of a source the plan doesn't list",
      on({ type: "video.insertClips", at: 90, clips: [newClip("c", 10, { source: "s9" })] }),
      refused("unknown-source"),
    ],
    [
      "refuses a range off the frame grid",
      on({ type: "video.trimClip", key: "a", start: 0, end: 1_000_000 }),
      refused("off-grid"),
    ],
    [
      "refuses a trim past the source's end",
      on({ type: "video.trimClip", key: "a", start: 9_000_000, end: clipEnd(9_000_000, 60, NTSC) }),
      refused("clip-outside-source"),
    ],
    [
      "refuses a volume over 24 dB",
      on({ type: "video.setVolume", keys: ["a"], volumeDb: 24.5 }),
      refused("volume-out-of-range"),
    ],
    [
      "refuses muted that isn't true or false",
      on({ type: "video.setMuted", keys: ["a"], muted: "yes" }),
      refused("invalid-muted"),
    ],
    [
      "refuses a negative fade",
      on({ type: "video.setFade", key: "a", edge: "in", duration: -1, curve: "linear" }),
      refused("invalid-fade"),
    ],
    [
      "refuses an unknown fade curve",
      on({ type: "video.setFade", key: "a", edge: "in", duration: 0, curve: "cubic" }),
      refused("invalid-fade-curve"),
    ],
    [
      "refuses fades that don't fit the clip together",
      on({ type: "video.setFade", key: "b", edge: "in", duration: 1_800_000, curve: "linear" }),
      refused("fades-too-long"),
    ],
    [
      "refuses a rotation that isn't a quarter turn",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: { rotation: 45, crop: null, fit: "contain" },
      }),
      refused("invalid-rotation"),
    ],
    [
      "refuses an unknown fit",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: { rotation: 0, crop: null, fit: "fill" },
      }),
      refused("invalid-fit"),
    ],
    [
      "refuses a crop in fractions of a pixel",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: { rotation: 0, crop: { x: 1.5, y: 0, width: 100, height: 100 }, fit: "contain" },
      }),
      refused("invalid-crop"),
    ],
    [
      "refuses a crop under 2 × 2 pixels",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: { rotation: 0, crop: { x: 0, y: 0, width: 1, height: 100 }, fit: "contain" },
      }),
      refused("crop-too-small"),
    ],
    [
      "refuses a crop outside the source as it's shown",
      on({
        type: "video.setTransform",
        keys: ["a"],
        transform: {
          rotation: 0,
          crop: { x: 1_900, y: 0, width: 100, height: 100 },
          fit: "contain",
        },
      }),
      refused("crop-outside-source"),
    ],
    [
      "refuses an odd output width",
      on({
        type: "video.setOutput",
        output: { width: 641, height: 360, frameRate: NTSC, sampleRate: 48_000, channels: 2 },
      }),
      refused("invalid-output-size"),
    ],
    [
      "refuses a frame rate with a denominator of 0",
      on({
        type: "video.setOutput",
        output: {
          width: 640,
          height: 360,
          frameRate: { num: 30, den: 0 },
          sampleRate: 48_000,
          channels: 2,
        },
      }),
      refused("invalid-frame-rate"),
    ],
    [
      "refuses a sample rate of 0",
      on({
        type: "video.setOutput",
        output: { width: 640, height: 360, frameRate: NTSC, sampleRate: 0, channels: 2 },
      }),
      refused("invalid-sample-rate"),
    ],
    [
      "refuses no audio channels",
      on({
        type: "video.setOutput",
        output: { width: 640, height: 360, frameRate: NTSC, sampleRate: 48_000, channels: 0 },
      }),
      refused("invalid-channels"),
    ],
  ];
  // A balanced sample: commands that apply, and a few of each refusal, so
  // the file stays small enough to review.
  const generated: ConformanceCase[] = [];
  const refusals = new Map<string, number>();
  let applies = 0;
  const samples = fc.sample(
    planArb.chain((state) => fc.tuple(fc.constant(state), commandFor(state))),
    { seed: SEED, numRuns: 2_000 },
  );
  for (const [state, command] of samples) {
    const made = make(
      "",
      { plan: toVideoPlanDocument(state, generatedSources), command },
      applyToDocument,
    );
    const reason = (made.expected as { error?: { reason: string } }).error?.reason;
    if (
      reason === undefined
        ? applies >= GENERATED_APPLIED
        : (refusals.get(reason) ?? 0) >= GENERATED_PER_REFUSAL
    ) {
      continue;
    }
    if (reason === undefined) applies += 1;
    else refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
    const outcome = reason === undefined ? "applied" : `refused, ${reason}`;
    generated.push({
      ...made,
      name: `generated ${generated.length + 1}: ${command.type}, ${outcome}`,
    });
  }
  return {
    format: "hm-conformance",
    version: 1,
    subject: "hm-video-commands",
    description:
      "video-sdk's edit commands (docs/formats/hm-video-plan.md). input.plan is an hm-video-plan document and input.command an hm-video-command; expected is the resulting document, or the rejection. Applying the command's inverse must restore the plan, but the inverse itself is internal. Generated cases come from the reducer's property-test generators, with a fixed seed.",
    cases: [
      ...handWritten.map(([name, input, outcome]) => make(name, input, applyToDocument, outcome)),
      ...generated,
    ],
  };
}

/** `hm-video-plan`: a document read and written back. */
export function planCases(): ConformanceFile {
  const document = (changes: Record<string, unknown>) => ({ ...BASE, ...changes });
  const withClip = (changes: Record<string, unknown>) =>
    document({ clips: [{ ...BASE.clips[0], ...changes }, BASE.clips[1]] });
  const withSource = (changes: Record<string, unknown>) =>
    document({ sources: { ...BASE.sources, s1: { ...BASE.sources["s1"], ...changes } } });
  const asset = `sha256:${"0a".repeat(32)}`;
  const handWritten: [string, unknown, Outcome][] = [
    ["reads a plan", BASE, applied],
    ["reads an empty plan", document({ clips: [], sources: {} }), applied],
    [
      "reads a source with its asset",
      withSource({ asset: { asset, mediaType: "video/mp4", size: 4_044 } }),
      applied,
    ],
    [
      "treats __proto__, constructor and toString as ordinary source ids and clip keys",
      PROTOTYPE_NAMED,
      applied,
    ],
    [
      "refuses another format",
      document({ format: "hm-audio-plan" }),
      refused("unknown-format", "UNSUPPORTED_FORMAT"),
    ],
    [
      "refuses a later version",
      document({ version: 2 }),
      refused("unknown-format-version", "UNSUPPORTED_FORMAT"),
    ],
    ["refuses a list", [BASE], invalidDocument("malformed-document")],
    [
      "refuses a version that isn't a number",
      document({ version: "1" }),
      invalidDocument("malformed-document"),
    ],
    ["refuses an unknown field", document({ tracks: 2 }), invalidDocument("malformed-document")],
    [
      "refuses a missing field",
      { ...BASE, metadata: undefined },
      invalidDocument("malformed-document"),
    ],
    [
      "refuses a source of no duration",
      withSource({ duration: 0 }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses a source rotation that isn't a quarter turn",
      withSource({ rotation: 45 }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses an asset that isn't a SHA-256",
      withSource({ asset: { asset: "md5:00", mediaType: "video/mp4", size: 1 } }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses a media type in capitals",
      withSource({ asset: { asset, mediaType: "Video/MP4", size: 1 } }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses an unknown clip field",
      withClip({ speed: 2 }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses an unknown metadata field",
      document({ metadata: { ...BASE.metadata, genre: "" } }),
      invalidDocument("malformed-document"),
    ],
    [
      "refuses an odd output height",
      document({ output: { ...BASE.output, height: 361 } }),
      invalidDocument("invalid-output-size"),
    ],
    [
      "refuses a frame rate of 0",
      document({ output: { ...BASE.output, frameRate: { num: 0, den: 1 } } }),
      invalidDocument("invalid-frame-rate"),
    ],
    [
      "refuses a clip of a source it doesn't list",
      withClip({ source: "s9" }),
      invalidDocument("unknown-source"),
    ],
    [
      "refuses two clips with one key",
      document({ clips: [BASE.clips[0], { ...BASE.clips[1], key: "a" }] }),
      invalidDocument("duplicate-key"),
    ],
    [
      "refuses an unknown fade curve",
      withClip({ fadeIn: { duration: 0, curve: "cubic" } }),
      invalidDocument("invalid-fade-curve"),
    ],
    [
      "refuses metadata over 1,000 characters",
      document({ metadata: { ...BASE.metadata, title: "x".repeat(1_001) } }),
      invalidDocument("metadata-too-long"),
    ],
    [
      "refuses a clip off the output's frame grid",
      withClip({ end: 1_000_000 }),
      invalidDocument("off-grid"),
    ],
    [
      "refuses a clip past its source",
      withClip({ start: 9_000_000, end: clipEnd(9_000_000, 60, NTSC) }),
      invalidDocument("clip-outside-source"),
    ],
    ["refuses a negative microsecond", withClip({ start: -1 }), invalidDocument("invalid-range")],
    [
      "refuses a volume under -96 dB",
      withClip({ volumeDb: -97 }),
      invalidDocument("volume-out-of-range"),
    ],
    [
      "refuses fades that don't fit their clip",
      withClip({
        fadeIn: { duration: 600_000, curve: "linear" },
        fadeOut: { duration: 500_000, curve: "linear" },
      }),
      invalidDocument("fades-too-long"),
    ],
    [
      "refuses a crop outside its source as it's shown",
      withClip({
        transform: {
          rotation: 90,
          crop: { x: 0, y: 0, width: 1_920, height: 100 },
          fit: "contain",
        },
      }),
      invalidDocument("crop-outside-source"),
    ],
  ];
  const generated = fc
    .sample(planArb, { seed: SEED, numRuns: GENERATED_PLANS })
    .map((state, index) =>
      make(
        `generated ${index + 1}: ${state.clips.length} clips`,
        toVideoPlanDocument(state, generatedSources),
        readAndWrite,
        applied,
      ),
    );
  return {
    format: "hm-conformance",
    version: 1,
    subject: "hm-video-plan",
    description:
      "Reading hm-video-plan documents (docs/formats/hm-video-plan.md): input is the document, and expected is the document as a reader writes it back, or the rejection.",
    cases: [
      ...handWritten.map(([name, input, outcome]) => make(name, input, readAndWrite, outcome)),
      ...generated,
    ],
  };
}
