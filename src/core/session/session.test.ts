import { describe, expect, it } from "vitest";
import { createFakeEngine, type FakeEngine } from "../../../test/fakes/fake-engine.js";
import { encodeFakeVideo, type FakeVideoSpec } from "../../../test/fakes/fake-video.js";
import { isVideoError, type VideoErrorCode } from "../errors/video-error.js";
import type { VideoFilePolicyOverrides } from "../errors/video-limits.js";
import { clipFrames, planFrames } from "../model/plan.js";
import { decodingBound } from "../model/probe-limits.js";
import { createVideoSession, type VideoSessionEvent } from "./session.js";

const CLIP: FakeVideoSpec = {
  width: 1280,
  height: 720,
  rate: { num: 30, den: 1 },
  frames: 60,
  audio: { sampleRate: 48_000, channels: 2 },
};
const file = (spec: Partial<FakeVideoSpec> = {}) => encodeFakeVideo({ ...CLIP, ...spec });

function setup(filePolicy?: VideoFilePolicyOverrides, engine: FakeEngine = createFakeEngine()) {
  const events: VideoSessionEvent[] = [];
  const session = createVideoSession({
    engine,
    ...(filePolicy ? { filePolicy } : {}),
    onEvent: (event) => events.push(event),
  });
  return { session, engine, events };
}

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const code = (error: unknown) => (isVideoError(error) ? error.code : error);

/** A fake engine whose probe or open waits at a gate the test opens. */
function gated(step: "probe" | "open") {
  const engine = createFakeEngine();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    if (step === "probe") {
      const probe = engine.probe;
      engine.probe = async (f, o) => {
        resolve();
        await gate;
        return probe(f, o);
      };
    } else {
      const openSource = engine.open;
      engine.open = async (id, f, p, o) => {
        // Opens at once, then waits: the source is open when the abort lands.
        const info = await openSource(id, f, p, o);
        resolve();
        await gate;
        return info;
      };
    }
  });
  return { engine, entered, release: () => open() };
}

describe("the video session", () => {
  it("starts empty", () => {
    const { session } = setup();
    expect(session.getSnapshot()).toMatchObject({
      status: "empty",
      plan: null,
      sources: [],
      canUndo: false,
      inserting: 0,
      decodingBytes: 0,
      error: null,
    });
  });

  it("inserts the first file as one clip, taking the plan's output from it", async () => {
    const { session, engine, events } = setup();
    const info = await session.insert(file());
    const { plan, sources, canUndo, decodingBytes } = session.getSnapshot();
    expect(plan?.output).toEqual({
      width: 1280,
      height: 720,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48_000,
      channels: 2,
    });
    expect(plan?.clips).toHaveLength(1);
    expect(plan && planFrames(plan)).toBe(60);
    expect(sources).toEqual([info]);
    expect(engine.sources.has(info.id)).toBe(true);
    expect(canUndo).toBe(true);
    expect(decodingBytes).toBe(decodingBound(await engine.probe(file())));
    expect(events).toEqual([{ type: "insert", outcome: "done", commands: ["video.insertClips"] }]);
  });

  it("appends later files, and splits a clip to insert inside it, as one undoable step", async () => {
    const { session } = setup();
    await session.insert(file());
    await session.insert(file({ frames: 30 }));
    expect(
      session.getSnapshot().plan?.clips.map((clip) => clipFrames(clip, { num: 30, den: 1 })),
    ).toEqual([60, 30]);
    await session.insert(file({ frames: 15 }), { at: 20 });
    expect(
      session.getSnapshot().plan?.clips.map((clip) => clipFrames(clip, { num: 30, den: 1 })),
    ).toEqual([20, 15, 40, 30]);
    expect(session.undo()).toBe(true);
    expect(
      session.getSnapshot().plan?.clips.map((clip) => clipFrames(clip, { num: 30, den: 1 })),
    ).toEqual([60, 30]);
  });

  it("checks the probe against the limits before opening, and leaves nothing behind", async () => {
    const { session, engine, events } = setup({ maxFramePixels: 1_000 });
    expect(code(await rejection(session.insert(file())))).toBe("FRAME_TOO_LARGE");
    expect(engine.sources.size).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ plan: null, sources: [], canUndo: false });
    expect(session.getSnapshot().error?.code).toBe("FRAME_TOO_LARGE");
    expect(events).toEqual([{ type: "insert", outcome: "failed", commands: [] }]);
  });

  it.each<[string, Blob, VideoErrorCode]>([
    ["a file it can't read", new Blob(["not a video"]), "UNSUPPORTED_FORMAT"],
    ["a codec it can't decode", file({ codec: "hvc1.1.6.L93.B0" }), "UNSUPPORTED_CODEC"],
  ])("refuses %s, and leaves nothing behind", async (_, bad, expected) => {
    const { session, engine } = setup();
    await session.insert(file());
    const before = session.getSnapshot().plan;
    expect(code(await rejection(session.insert(bad)))).toBe(expected);
    expect(engine.sources.size).toBe(1);
    expect(session.getSnapshot().plan).toBe(before);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().canUndo).toBe(false);
  });

  it("refuses a file over maxFiles", async () => {
    const { session, engine } = setup({ maxFiles: 1 });
    await session.insert(file());
    expect(code(await rejection(session.insert(file())))).toBe("TOO_MANY_FILES");
    expect(engine.sources.size).toBe(1);
  });

  it("refuses an insert that would break maxClips or the plan's maxDuration, and closes its source", async () => {
    const clips = setup({ maxClips: 1 });
    await clips.session.insert(file());
    expect(code(await rejection(clips.session.insert(file())))).toBe("TOO_MANY_CLIPS");
    expect(clips.engine.sources.size).toBe(1);

    // Each file is 2 s, within 3 s; together they're 4 s.
    const length = setup({ maxDuration: 3_000 });
    await length.session.insert(file());
    expect(code(await rejection(length.session.insert(file())))).toBe("DURATION_TOO_LONG");
    expect(length.engine.sources.size).toBe(1);
    expect(length.session.getSnapshot().plan?.clips).toHaveLength(1);
  });

  it.each(["probe", "open"] as const)(
    "cancels an insert during %s, leaving nothing open",
    async (step) => {
      const { engine, entered, release } = gated(step);
      const { session, events } = setup(undefined, engine);
      const controller = new AbortController();
      const inserting = session.insert(file(), { signal: controller.signal });
      await entered;
      expect(session.getSnapshot().inserting).toBe(1);
      controller.abort();
      release();
      expect(code(await rejection(inserting))).toBe("ABORTED");
      expect(engine.sources.size).toBe(0);
      expect(session.getSnapshot()).toMatchObject({
        plan: null,
        sources: [],
        inserting: 0,
        canUndo: false,
      });
      expect(events).toEqual([{ type: "insert", outcome: "cancelled", commands: [] }]);
    },
  );

  it("closes a source once neither the plan nor the history refers to it", async () => {
    const { session, engine } = setup();
    const first = await session.insert(file());
    const second = await session.insert(file({ frames: 30 }));
    // Undone, the second file's clip is only in the redo step, so it stays open.
    session.undo();
    expect(engine.sources.has(second.id)).toBe(true);
    // A new edit drops the redo step, and with it the last reference.
    const key = session.getSnapshot().plan?.clips[0]?.key as string;
    session.execute({ type: "video.setMuted", keys: [key], muted: true });
    await Promise.resolve();
    expect(engine.sources.has(second.id)).toBe(false);
    expect(engine.sources.has(first.id)).toBe(true);
    expect(session.getSnapshot().sources.map((source) => source.id)).toEqual([first.id]);
  });

  it("applies an edit as one step, refuses an invalid one without changing anything, and undoes and redoes", async () => {
    const { session, events } = setup();
    await session.insert(file());
    const before = session.getSnapshot().plan;
    const key = before?.clips[0]?.key as string;
    expect(
      code(
        await rejection(() =>
          session.execute({ type: "video.splitClip", key, at: 0, newKey: "n" }),
        ),
      ),
    ).toBe("INVALID_COMMAND");
    expect(session.getSnapshot().plan).toBe(before);
    expect(session.getSnapshot().error?.code).toBe("INVALID_COMMAND");

    session.execute([
      { type: "video.splitClip", key, at: 30, newKey: "b" },
      { type: "video.setMuted", keys: ["b"], muted: true },
    ]);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().plan?.clips).toHaveLength(2);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().plan?.clips).toHaveLength(1);
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().plan?.clips[1]?.muted).toBe(true);
    expect(session.redo()).toBe(false);
    expect(events.map((event) => `${event.type}:${event.outcome}`)).toEqual([
      "insert:done",
      "execute:failed",
      "execute:done",
      "undo:done",
      "redo:done",
    ]);
  });

  it("refuses an output over the limits", async () => {
    const { session } = setup();
    await session.insert(file());
    const output = session.getSnapshot().plan?.output;
    if (!output) throw new Error("expected a plan");
    const tooLarge = { ...output, width: 8_192, height: 8_192 };
    expect(
      code(await rejection(() => session.execute({ type: "video.setOutput", output: tooLarge }))),
    ).toBe("FRAME_TOO_LARGE");
    expect(session.getSnapshot().plan?.output).toEqual(output);
  });

  it("refuses edits before the first file", async () => {
    const { session } = setup();
    expect(
      code(
        await rejection(() =>
          session.execute({ type: "video.setMetadata", field: "title", value: "x" }),
        ),
      ),
    ).toBe("INVALID_COMMAND");
  });

  it("keeps a selection within the plan, and clears it when the plan gets shorter", async () => {
    const { session } = setup();
    await session.insert(file());
    expect(code(await rejection(() => session.select({ start: 10, end: 61 })))).toBe(
      "INVALID_COMMAND",
    );
    session.select({ start: 40, end: 60 });
    expect(session.getSnapshot().selection).toEqual({ start: 40, end: 60 });
    session.execute({ type: "video.deleteRange", start: 0, end: 30, keys: [] });
    expect(session.getSnapshot().selection).toBeNull();
  });

  it("notifies subscribers with a new snapshot, and survives a host's onEvent that throws", async () => {
    const engine = createFakeEngine();
    const session = createVideoSession({
      engine,
      onEvent: () => {
        throw new Error("the host's handler failed");
      },
    });
    const seen: unknown[] = [];
    const unsubscribe = session.subscribe(() => seen.push(session.getSnapshot()));
    await session.insert(file());
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
    unsubscribe();
  });

  it("closes every source on destroy, and refuses calls afterwards", async () => {
    const { session, engine } = setup();
    await session.insert(file());
    await session.insert(file());
    await session.destroy();
    expect(engine.sources.size).toBe(0);
    expect(session.getSnapshot()).toMatchObject({ status: "empty", sources: [] });
    await expect(session.insert(file())).rejects.toThrow();
  });
});
