import { describe, expect, it, vi } from "vitest";
import { createFakeEngine, type FakeEngine } from "../../../test/fakes/fake-engine.js";
import { createFakeProcessor } from "../../../test/fakes/fake-processor.js";
import { encodeFakeVideo, type FakeVideoSpec } from "../../../test/fakes/fake-video.js";
import { isVideoError, type VideoErrorCode } from "../errors/video-error.js";
import type { VideoFilePolicyOverrides } from "../errors/video-limits.js";
import { clipFrames, planFrames } from "../model/plan.js";
import { decodingBound } from "../model/probe-limits.js";
import type { VideoExportJob } from "../ports/video-processor.js";
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
/** An error's `details.reason`, which picks its text (see videoErrorText). */
const reason = (error: unknown) =>
  isVideoError(error) ? (error.details as { reason?: unknown } | undefined)?.reason : error;

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
    const refused = await rejection(session.insert(file()));
    expect(code(refused)).toBe("FRAME_TOO_LARGE");
    // The file's own limit: its text is the code's, about the video opened.
    expect(reason(refused)).toBeUndefined();
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

  it("counts inserts in flight against maxFiles, so concurrent inserts can't exceed it", async () => {
    const { session, engine } = setup({ maxFiles: 2 });
    await session.insert(file());
    const results = await Promise.allSettled([session.insert(file()), session.insert(file())]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [refused] = results.filter((result) => result.status === "rejected");
    expect(code((refused as PromiseRejectedResult).reason)).toBe("TOO_MANY_FILES");
    expect(engine.sources.size).toBe(2);
    expect(session.getSnapshot().sources).toHaveLength(2);
  });

  it("refuses an insert that would break maxClips or the plan's maxDuration, and closes its source", async () => {
    const clips = setup({ maxClips: 1 });
    await clips.session.insert(file());
    expect(code(await rejection(clips.session.insert(file())))).toBe("TOO_MANY_CLIPS");
    expect(clips.engine.sources.size).toBe(1);

    // Each file is 2 s, within 3 s; together they're 4 s.
    const length = setup({ maxDuration: 3_000 });
    await length.session.insert(file());
    const tooLong = await rejection(length.session.insert(file()));
    expect(code(tooLong)).toBe("DURATION_TOO_LONG");
    // Neither file is too long: the edited video would be.
    expect(reason(tooLong)).toBe("plan-too-long");
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

  it("gives new clip keys that no clip has had, in the plan or its history, nor a host's own", async () => {
    const { session } = setup();
    await session.insert(file());
    const first = session.getSnapshot().plan?.clips[0]?.key as string;
    // A split's second part, then undone: its key is still in the redo history.
    const split = session.newClipKey();
    session.execute({ type: "video.splitClip", key: first, at: 30, newKey: split });
    session.undo();
    // A host's own keys, in the session's style, ahead of its counter.
    const taken = Array.from({ length: 6 }, (_, index) => `clip-${index + 1}`);
    const host = taken.filter((key) => key !== first && key !== split);
    const keys = new Set<string>([first, split]);
    session.execute({ type: "video.splitClip", key: first, at: 10, newKey: host[0] as string });
    session.execute({ type: "video.splitClip", key: first, at: 5, newKey: host[1] as string });
    for (const key of host.slice(0, 2)) keys.add(key);
    const fresh = [session.newClipKey(), session.newClipKey(), session.newClipKey()];
    expect(new Set(fresh).size).toBe(3);
    for (const key of fresh) expect(keys.has(key), key).toBe(false);
    // Each is usable: undo and redo of edits that use them never collide.
    session.execute({ type: "video.splitClip", key: first, at: 2, newKey: fresh[0] as string });
    session.undo();
    session.redo();
    expect(session.getSnapshot().plan?.clips.map((clip) => clip.key)).toContain(fresh[0]);
    await session.destroy();
    expect(() => session.newClipKey()).toThrow();
  });

  it("refuses an output over the limits", async () => {
    const { session } = setup();
    await session.insert(file());
    const output = session.getSnapshot().plan?.output;
    if (!output) throw new Error("expected a plan");
    const tooLarge = { ...output, width: 8_192, height: 8_192 };
    const refused = await rejection(() =>
      session.execute({ type: "video.setOutput", output: tooLarge }),
    );
    expect(code(refused)).toBe("FRAME_TOO_LARGE");
    expect(reason(refused)).toBe("output");
    expect(session.getSnapshot().error?.details).toMatchObject({
      reason: "output",
      actual: 8_192 * 8_192,
    });
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

describe("warnings", () => {
  it("names the limit, its value and the file a file's warning is about, and the plan's without a file", async () => {
    // Warn from one second, and from 720p frames; the clip is 2 s of 1280 × 720.
    const { session } = setup({
      maxDuration: { maximum: 60_000, warning: 1_000 },
      maxFramePixels: { maximum: 3840 * 2160, warning: 1280 * 720 },
    });
    const info = await session.insert(file());
    const { warnings } = session.getSnapshot();
    expect(warnings).toContainEqual({
      type: "limit",
      limit: "maxDuration",
      actual: 2_000,
      source: info.id,
    });
    expect(warnings).toContainEqual({
      type: "limit",
      limit: "maxFramePixels",
      actual: 1280 * 720,
      source: info.id,
    });
    // The output's and the plan's own warnings name no file.
    expect(warnings).toContainEqual({ type: "limit", limit: "maxFramePixels", actual: 1280 * 720 });
    expect(warnings).toContainEqual({ type: "limit", limit: "maxDuration", actual: 2_000 });
    // One per limit and file.
    expect(warnings).toHaveLength(4);
    // An edit keeps only what it comes near: the plan and the output.
    const key = session.getSnapshot().plan?.clips[0]?.key as string;
    session.execute({ type: "video.setMuted", keys: [key], muted: true });
    expect(session.getSnapshot().warnings.every((warning) => warning.source === undefined)).toBe(
      true,
    );
  });
});

describe("exporting through the session", () => {
  /** A session with the fake processor, over the fake engine's sources. */
  function withProcessor() {
    const engine = createFakeEngine();
    const processor = createFakeProcessor(engine.sources);
    const events: VideoSessionEvent[] = [];
    const exported: VideoExportJob[] = [];
    const session = createVideoSession({
      engine,
      onEvent: (event) => events.push(event),
      processor: {
        export(job, options) {
          exported.push(job);
          return processor.export(job, options);
        },
        destroy: () => processor.destroy(),
      },
    });
    return { session, events, exported };
  }

  it("exports the plan as it is when the call starts, with the job's options, and says so", async () => {
    const { session, events, exported } = withProcessor();
    await session.insert(file());
    const progress: number[] = [];
    const exporting = session.export({
      container: "webm",
      quality: "high",
      onProgress: (fraction) => progress.push(fraction),
    });
    // An edit while it runs changes the session, not the file.
    const key = session.getSnapshot().plan?.clips[0]?.key as string;
    session.execute({ type: "video.setMuted", keys: [key], muted: true });
    const result = await exporting;
    expect(result).toMatchObject({ container: "webm", clippedFrames: 0 });
    expect(result.size).toBe(result.blob.size);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ container: "webm", quality: "high" });
    expect(exported[0]?.plan.clips[0]?.muted).toBe(false);
    expect(progress.at(-1)).toBe(1);
    expect(events.at(-1)).toEqual({ type: "export", outcome: "done", commands: [] });
  });

  it("refuses with no plan, and says a cancelled export was cancelled", async () => {
    const { session, events } = withProcessor();
    const none = await rejection(session.export());
    expect(code(none)).toBe("INVALID_COMMAND");
    expect((none as { details?: unknown }).details).toEqual({ reason: "no-plan" });
    expect(events.at(-1)).toMatchObject({ type: "export", outcome: "failed" });
    await session.insert(file());
    const controller = new AbortController();
    controller.abort();
    expect(code(await rejection(session.export({ signal: controller.signal })))).toBe("ABORTED");
    expect(events.at(-1)).toMatchObject({ type: "export", outcome: "cancelled" });
    // An export's failure isn't the session's: the snapshot keeps no error for it.
    expect(session.getSnapshot().error).toBeNull();
  });

  it("throws TypeError without a processor", async () => {
    const { session } = setup();
    await session.insert(file());
    expect(await rejection(session.export())).toBeInstanceOf(TypeError);
  });
});

/** A fake engine whose peaks wait until the test lets them through, one by one. */
function slowPeaks() {
  const engine = createFakeEngine();
  const waiting: { readonly id: string; readonly release: () => void }[] = [];
  const signals: AbortSignal[] = [];
  const peaks = engine.peaks;
  engine.peaks = async (id, options) => {
    if (options?.signal) signals.push(options.signal);
    await new Promise<void>((resolve) => waiting.push({ id, release: resolve }));
    return peaks(id, {});
  };
  return { engine, waiting, signals };
}

describe("a source's peaks", () => {
  it("are built in the background after the insert, and bump peaksVersion when they arrive", async () => {
    const { engine, waiting } = slowPeaks();
    const { session } = setup(undefined, engine);
    const info = await session.insert(file());
    // The clip is in, and its peaks are still being built.
    expect(session.getSnapshot().plan?.clips).toHaveLength(1);
    expect(session.getPeaks(info.id)).toBeUndefined();
    expect(session.getSnapshot().peaksVersion).toBe(0);
    waiting.shift()?.release();
    await vi.waitFor(() => expect(session.getSnapshot().peaksVersion).toBe(1));
    expect(session.getPeaks(info.id)?.bucketDuration).toBe(10_000);
  });

  it("are never built for a source without sound", async () => {
    const { engine, waiting } = slowPeaks();
    const { session } = setup(undefined, engine);
    const info = await session.insert(file({ audio: null }));
    expect(waiting).toHaveLength(0);
    expect(session.getPeaks(info.id)).toBeUndefined();
  });

  it("are dropped when they arrive after their source was closed, and their build is cancelled", async () => {
    const { engine, waiting, signals } = slowPeaks();
    const { session } = setup(undefined, engine);
    const first = await session.insert(file());
    // Undone, then replaced by another edit: nothing refers to it, so it closes.
    session.undo();
    const second = await session.insert(file());
    expect(session.getSnapshot().sources.map((source) => source.id)).toEqual([second.id]);
    expect(signals[0]?.aborted).toBe(true);
    const published = session.getSnapshot().peaksVersion;
    waiting.find((each) => each.id === first.id)?.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getPeaks(first.id)).toBeUndefined();
    expect(session.getSnapshot().peaksVersion).toBe(published);
  });

  it("are dropped when they arrive after the session was destroyed", async () => {
    const { engine, waiting, signals } = slowPeaks();
    const { session } = setup(undefined, engine);
    const info = await session.insert(file());
    await session.destroy();
    expect(signals[0]?.aborted).toBe(true);
    waiting.shift()?.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getPeaks(info.id)).toBeUndefined();
    expect(session.getSnapshot().peaksVersion).toBe(0);
  });
});
