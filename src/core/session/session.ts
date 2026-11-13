import {
  applyCommands,
  createHistory,
  createStore,
  type HistoryStep,
} from "@hussmartinez/sdk-core";
import { asVideoError, throwIfAborted } from "../errors/error-helpers.js";
import { isVideoError, VideoError } from "../errors/video-error.js";
import {
  type VideoFilePolicy,
  type VideoFilePolicyOverrides,
  type VideoLimitName,
  videoLimits,
} from "../errors/video-limits.js";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  outputFromSource,
  planFrames,
  type VideoClip,
  type VideoPlan,
} from "../model/plan.js";
import { checkOutput, checkPlanLength, checkProbe, decodingBound } from "../model/probe-limits.js";
import type { VideoProbe, VideoSourceInfo } from "../model/source.js";
import { type FrameRate, frameTime, isWhole } from "../model/time.js";
import { createVideoReducer, type VideoCommand } from "../operations/commands.js";
import type { VideoEngine } from "../ports/video-engine.js";

/**
 * A range of the timeline, in output frames: `start` inclusive, `end`
 * exclusive.
 *
 * @public
 */
export interface VideoTimelineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * The session's state, for `useSyncExternalStore`: a new object on every
 * change (ADR 0003). The playhead isn't in it; it belongs to `VideoOutput`.
 *
 * @public
 */
export interface VideoSessionSnapshot {
  /** `empty` until the first file is inserted, then `ready`. */
  readonly status: "empty" | "ready";
  /** The document, or `null` before the first file. */
  readonly plan: VideoPlan | null;
  /** Every open source: those the plan or the undo history refers to. */
  readonly sources: readonly VideoSourceInfo[];
  /** View state, outside the history. */
  readonly selection: VideoTimelineRange | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** How many inserts are in progress. */
  readonly inserting: number;
  /**
   * What decoding can hold at once, in bytes: the two largest
   * `decodingBound`s of the open sources, because at most two sources decode
   * at once, at a cut between clips (ADR 0004).
   */
  readonly decodingBytes: number;
  /** The limits the last insert or edit came near, at or above their warnings. */
  readonly warnings: readonly VideoLimitName[];
  /** The last failure, until the next successful insert or edit. */
  readonly error: VideoError | null;
}

/**
 * An anonymous usage event for the host's `onEvent` (ADR 0003). It never
 * carries file names, frames, audio or metadata values.
 *
 * @public
 */
export interface VideoSessionEvent {
  readonly type: "insert" | "execute" | "undo" | "redo";
  readonly outcome: "done" | "failed" | "cancelled";
  /** The types of the commands applied or undone. */
  readonly commands: readonly VideoCommand["type"][];
}

/**
 * Options for {@link createVideoSession}.
 *
 * @public
 */
export interface VideoSessionOptions {
  /** Reads and opens files. The session closes the sources it opened, never the engine. */
  readonly engine: VideoEngine;
  /** The host's limits, over `videoLimits`' defaults (ADR 0004). */
  readonly filePolicy?: VideoFilePolicyOverrides;
  readonly onEvent?: (event: VideoSessionEvent) => void;
}

/**
 * Options for {@link VideoSession.insert}.
 *
 * @public
 */
export interface VideoInsertOptions {
  /**
   * The timeline frame to insert at, clamped to the plan's end. Inside a clip,
   * that clip is split there first, in the same undoable step. The end of the
   * plan by default.
   */
  readonly at?: number;
  readonly signal?: AbortSignal;
}

/**
 * A video editing session (ADR 0003, ADR 0008): the plan over the sources it
 * opened, edited by commands with undo and redo.
 *
 * @public
 */
export interface VideoSession {
  getSnapshot(): VideoSessionSnapshot;
  /** Calls the listener after every change. Returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void;
  /**
   * Probes, checks and opens a file, and inserts all of it as one clip
   * (ADR 0001, ADR 0004). The first file sets the plan's output. A failed or
   * cancelled insert leaves nothing behind: no source open, no clip and no
   * undo step.
   */
  insert(file: Blob, options?: VideoInsertOptions): Promise<VideoSourceInfo>;
  /**
   * Applies commands as one undoable step. They're checked by the reducer,
   * then the plan against `maxClips`, `maxDuration` and the output's limits;
   * a failure throws `VideoError` and changes nothing.
   */
  execute(commands: VideoCommand | readonly VideoCommand[]): void;
  /** Undoes the last step. Returns whether there was one. */
  undo(): boolean;
  /** Redoes the last undone step. Returns whether there was one. */
  redo(): boolean;
  /**
   * A key for a new clip, such as a split's second part: one no clip has
   * had in this session, in the plan or anywhere in its undo history, and
   * one this method hasn't returned before. Commands carry their new keys
   * (ADR 0003), so the reducer stays pure; this is where they come from.
   */
  newClipKey(): string;
  /** Sets or clears the selection, in timeline frames within the plan. */
  select(range: VideoTimelineRange | null): void;
  /** Closes every source the session opened. Later calls throw. */
  destroy(): Promise<void>;
}

/** The ids of the sources a step's commands refer to. */
function referencedSources(commands: readonly VideoCommand[], into: Set<string>): void {
  const add = (clip: VideoClip) => into.add(clip.source);
  for (const command of commands) {
    if (command.type === "video.insertClips") command.clips.forEach(add);
    else if (command.type === "video.restoreClips")
      for (const entry of command.entries) add(entry.clip);
    else if (command.type === "video.restoreOutput") command.clips.forEach(add);
  }
}

/** The whole of a source as one clip on this frame grid. */
function wholeClip(key: string, info: VideoSourceInfo, rate: FrameRate): VideoClip {
  let frames = Math.floor((info.duration * rate.num) / (1_000_000 * rate.den));
  while (frames > 0 && frameTime(frames, rate) > info.duration) frames -= 1;
  if (frames < 1) {
    throw new VideoError("INVALID_VIDEO", "The video is shorter than one frame.", {
      details: { reason: "too-short" },
    });
  }
  return {
    key,
    source: info.id,
    start: 0,
    end: clipEnd(0, frames, rate),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

/**
 * Creates a {@link VideoSession} (ADR 0003): its store and history are
 * sdk-core's (ADR 0029), its reducer is {@link createVideoReducer}, and it
 * reaches files only through its engine.
 *
 * @example
 * ```ts
 * const session = createVideoSession({ engine: createVideoEngine() });
 * await session.insert(file);
 * session.execute({ type: "video.setMuted", keys: [key], muted: true });
 * session.undo();
 * ```
 *
 * @public
 */
export function createVideoSession(options: VideoSessionOptions): VideoSession {
  const { engine } = options;
  const policy: VideoFilePolicy = videoLimits.resolve(options.filePolicy);
  const sources = new Map<string, { readonly info: VideoSourceInfo; readonly probe: VideoProbe }>();
  const history = createHistory<VideoCommand>();
  const reducer = createVideoReducer((id) => sources.get(id)?.info);
  let plan: VideoPlan | null = null;
  let selection: VideoTimelineRange | null = null;
  let inserting = 0;
  let warnings: readonly VideoLimitName[] = [];
  let error: VideoError | null = null;
  let nextId = 0;
  let destroyed = false;
  /** A new id or key, unique within the session. */
  const fresh = (prefix: string) => {
    nextId += 1;
    return `${prefix}-${nextId}`;
  };
  /**
   * Every clip key the session has held, or handed out. Each plan in the
   * undo history was the current plan once, so this covers the history too,
   * and keys a host chose itself.
   */
  const usedKeys = new Set<string>();
  const newClipKey = () => {
    let key = fresh("clip");
    while (usedKeys.has(key)) key = fresh("clip");
    usedKeys.add(key);
    return key;
  };

  const snapshot = (): VideoSessionSnapshot => {
    const bounds = [...sources.values()]
      .map(({ probe }) => decodingBound(probe))
      .sort((a, b) => b - a);
    return {
      status: plan === null ? "empty" : "ready",
      plan,
      sources: [...sources.values()].map(({ info }) => info),
      selection,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      inserting,
      decodingBytes: (bounds[0] ?? 0) + (bounds[1] ?? 0),
      warnings,
      error,
    };
  };
  const store = createStore<VideoSessionSnapshot>(snapshot());
  const publish = () => {
    for (const clip of plan?.clips ?? []) usedKeys.add(clip.key);
    store.set(snapshot());
  };
  const emit = (event: VideoSessionEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A host's handler can't break the session.
    }
  };
  const assertAlive = () => {
    if (destroyed) throw new Error("The video session has been destroyed.");
  };
  const fail = (reason: unknown): VideoError => {
    error = isVideoError(reason) ? reason : asVideoError(reason);
    return error;
  };

  /** Closes every source that neither the plan nor any history step refers to. */
  const release = () => {
    const referenced = new Set<string>();
    if (plan) for (const clip of plan.clips) referenced.add(clip.source);
    for (const step of history.steps) {
      referencedSources(step.commands, referenced);
      referencedSources(step.inverses, referenced);
    }
    for (const id of [...sources.keys()]) {
      if (!referenced.has(id)) {
        sources.delete(id);
        void engine.close(id).catch(() => {});
      }
    }
  };

  /** The plan after `commands`, checked against the limits, and their inverses. */
  const attempt = (from: VideoPlan, commands: readonly VideoCommand[]) => {
    const { state, inverses } = applyCommands(reducer, from, commands);
    policy.check("maxClips", state.clips.length);
    const near: VideoLimitName[] = [...checkOutput(policy, state.output)];
    if (checkPlanLength(policy, state)) near.push("maxDuration");
    return { state, step: { commands: [...commands], inverses: [...inverses] }, near };
  };

  const replay = (direction: "undo" | "redo"): boolean => {
    assertAlive();
    const step: HistoryStep<VideoCommand> | undefined =
      direction === "undo" ? history.undo() : history.redo();
    if (!step || plan === null) return false;
    const commands = direction === "undo" ? step.inverses : step.commands;
    try {
      plan = applyCommands(reducer, plan, commands).state;
    } catch (reason) {
      history.restore(direction);
      publish();
      emit({ type: direction, outcome: "failed", commands: commands.map((c) => c.type) });
      throw fail(reason);
    }
    error = null;
    if (selection && selection.end > planFrames(plan)) selection = null;
    publish();
    emit({ type: direction, outcome: "done", commands: commands.map((c) => c.type) });
    return true;
  };

  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => store.subscribe(listener),

    async insert(file, insertOptions = {}) {
      assertAlive();
      const { signal } = insertOptions;
      const id = fresh("source");
      let opened = false;
      inserting += 1;
      publish();
      try {
        throwIfAborted(signal);
        // Inserts still in flight count too, this one included, so that
        // inserts started together can't pass the check together.
        policy.check("maxFiles", sources.size + inserting);
        const probe = await engine.probe(file, {
          filePolicy: policy,
          ...(signal ? { signal } : {}),
        });
        const near: VideoLimitName[] = [...checkProbe(policy, probe)];
        throwIfAborted(signal);
        const info = await engine.open(id, file, probe, {
          filePolicy: policy,
          ...(signal ? { signal } : {}),
        });
        opened = true;
        throwIfAborted(signal);
        assertAlive();

        // From here to the end nothing awaits, so the plan can't change under us.
        const base = plan ?? createPlan(outputFromSource(info));
        const rate = base.output.frameRate;
        const total = planFrames(base);
        const at = insertOptions.at ?? total;
        if (!isWhole(at)) {
          throw new VideoError("INVALID_COMMAND", "An insert position must be a whole frame.", {
            details: { reason: "malformed-command" },
          });
        }
        const frame = Math.min(at, total);
        const commands: VideoCommand[] = [];
        const offsets = clipOffsets(base);
        const inside = base.clips.findIndex((clip, index) => {
          const from = offsets[index] ?? 0;
          return from < frame && frame < from + clipFrames(clip, rate);
        });
        const key = newClipKey;
        if (inside >= 0) {
          commands.push({
            type: "video.splitClip",
            key: (base.clips[inside] as VideoClip).key,
            at: frame,
            newKey: key(),
          });
        }
        commands.push({
          type: "video.insertClips",
          at: frame,
          clips: [wholeClip(key(), info, rate)],
        });

        sources.set(id, { info, probe });
        let result: ReturnType<typeof attempt>;
        try {
          result = attempt(base, commands);
          if (plan === null) near.push(...checkOutput(policy, base.output));
        } catch (reason) {
          sources.delete(id);
          throw reason;
        }
        plan = result.state;
        history.push(result.step);
        warnings = [...new Set([...near, ...result.near])];
        error = null;
        release();
        emit({ type: "insert", outcome: "done", commands: commands.map((c) => c.type) });
        return info;
      } catch (reason) {
        if (opened && !sources.has(id)) await engine.close(id).catch(() => {});
        const failure = fail(reason);
        emit({
          type: "insert",
          outcome: failure.code === "ABORTED" ? "cancelled" : "failed",
          commands: [],
        });
        throw failure;
      } finally {
        inserting -= 1;
        publish();
      }
    },

    execute(input) {
      assertAlive();
      const commands = Array.isArray(input)
        ? (input as readonly VideoCommand[])
        : [input as VideoCommand];
      try {
        if (plan === null) {
          throw new VideoError(
            "INVALID_COMMAND",
            "There's nothing to edit before a file is inserted.",
            { details: { reason: "no-plan" } },
          );
        }
        const result = attempt(plan, commands);
        plan = result.state;
        history.push(result.step);
        warnings = result.near;
        error = null;
        if (selection && selection.end > planFrames(plan)) selection = null;
        release();
        emit({ type: "execute", outcome: "done", commands: commands.map((c) => c.type) });
      } catch (reason) {
        emit({ type: "execute", outcome: "failed", commands: commands.map((c) => c.type) });
        throw fail(reason);
      } finally {
        publish();
      }
    },

    newClipKey() {
      assertAlive();
      return newClipKey();
    },

    undo: () => replay("undo"),
    redo: () => replay("redo"),

    select(range) {
      assertAlive();
      if (range !== null) {
        const total = plan ? planFrames(plan) : 0;
        const reason =
          !isWhole(range.start) || !isWhole(range.end)
            ? "malformed-command"
            : range.start >= range.end
              ? "empty-range"
              : range.end > total
                ? "frame-outside-plan"
                : undefined;
        if (reason !== undefined) {
          throw new VideoError(
            "INVALID_COMMAND",
            "A selection must be whole frames within the plan.",
            {
              details: { reason },
            },
          );
        }
      }
      selection = range;
      publish();
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      const ids = [...sources.keys()];
      sources.clear();
      history.clear();
      plan = null;
      selection = null;
      publish();
      await Promise.all(ids.map((id) => engine.close(id).catch(() => {})));
    },
  };
}
