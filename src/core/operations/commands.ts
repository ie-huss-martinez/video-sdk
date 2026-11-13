import type { Reducer } from "@hussmartinez/sdk-core";
import { VideoError } from "../errors/video-error.js";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  clipProblem,
  PROBLEM_MESSAGES,
  planFrames,
  type VideoClip,
  type VideoFadeCurve,
  type VideoMetadata,
  type VideoPlan,
  type VideoPlanOutput,
  type VideoSourceBounds,
  type VideoTransform,
} from "../model/plan.js";
import { type FrameRate, framesIn, frameTime } from "../model/time.js";
import {
  checkClip,
  Invalid,
  isKey,
  isMetadataField,
  isRecord,
  keyList,
  malformed,
  metadataValue,
  onlyFields,
  readClip,
  readFade,
  readOutput,
  readTransform,
  reject,
  whole,
} from "./read.js";

/**
 * A clip and the index it has, or had, in the plan's clip list.
 *
 * @public
 */
export interface VideoClipEntry {
  readonly index: number;
  readonly clip: VideoClip;
}

/**
 * Inserts clips at a timeline frame, which must be the start or end of a
 * clip. Split the clip there first to insert inside it.
 *
 * @public
 */
export interface InsertClipsCommand {
  readonly type: "video.insertClips";
  readonly at: number;
  readonly clips: readonly VideoClip[];
}

/**
 * Removes clips.
 *
 * @public
 */
export interface RemoveClipsCommand {
  readonly type: "video.removeClips";
  readonly keys: readonly string[];
}

/**
 * Removes the clips named in `remove`, then puts each entry's clip back at
 * its index, with every field as it was. An entry whose key is in the plan
 * replaces that clip. Entries are in ascending order of index. The inverse
 * of most edits.
 *
 * @public
 */
export interface RestoreClipsCommand {
  readonly type: "video.restoreClips";
  readonly entries: readonly VideoClipEntry[];
  readonly remove?: readonly string[];
}

/**
 * Removes the timeline frames from `start` to `end`, trimming or splitting
 * the clips the range touches. `keys` holds the key for the second half of
 * a clip that the range falls strictly inside, and is empty otherwise.
 *
 * @public
 */
export interface DeleteRangeCommand {
  readonly type: "video.deleteRange";
  readonly start: number;
  readonly end: number;
  readonly keys: readonly string[];
}

/**
 * Changes the source range a clip plays. The range must be on the frame
 * grid; fades longer than the new clip are shortened to fit.
 *
 * @public
 */
export interface TrimClipCommand {
  readonly type: "video.trimClip";
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Splits a clip at a timeline frame strictly inside it. The first part keeps
 * the key and the fade in; the second gets `newKey` and the fade out.
 *
 * @public
 */
export interface SplitClipCommand {
  readonly type: "video.splitClip";
  readonly key: string;
  readonly at: number;
  readonly newKey: string;
}

/**
 * Moves clips, in their current order, to a timeline frame of the plan
 * without them, which must be the start or end of a clip there.
 *
 * @public
 */
export interface MoveClipsCommand {
  readonly type: "video.moveClips";
  readonly keys: readonly string[];
  readonly to: number;
}

/**
 * Sets the audio volume of clips, in decibels.
 *
 * @public
 */
export interface SetVolumeCommand {
  readonly type: "video.setVolume";
  readonly keys: readonly string[];
  readonly volumeDb: number;
}

/**
 * Mutes or unmutes the audio of clips.
 *
 * @public
 */
export interface SetMutedCommand {
  readonly type: "video.setMuted";
  readonly keys: readonly string[];
  readonly muted: boolean;
}

/**
 * Sets a clip's audio fade in or fade out, in microseconds.
 *
 * @public
 */
export interface SetFadeCommand {
  readonly type: "video.setFade";
  readonly key: string;
  readonly edge: "in" | "out";
  readonly duration: number;
  readonly curve: VideoFadeCurve;
}

/**
 * Sets the rotation, crop and fit of clips.
 *
 * @public
 */
export interface SetTransformCommand {
  readonly type: "video.setTransform";
  readonly keys: readonly string[];
  readonly transform: VideoTransform;
}

/**
 * Sets the output. Every clip keeps its start; when the frame rate changes,
 * its end moves to the nearest frame of the new grid that fits its source,
 * and its fades are shortened to fit. A clip too near its source's end for
 * even one new frame moves its start back by what it needs.
 *
 * @public
 */
export interface SetOutputCommand {
  readonly type: "video.setOutput";
  readonly output: VideoPlanOutput;
}

/**
 * Puts the output and every clip back exactly as they were: the inverse of
 * {@link SetOutputCommand}. Like {@link RestoreClipsCommand}, it's undo's,
 * and isn't part of the portable command format.
 *
 * @public
 */
export interface RestoreOutputCommand {
  readonly type: "video.restoreOutput";
  readonly output: VideoPlanOutput;
  readonly clips: readonly VideoClip[];
}

/**
 * Sets one metadata field. An empty value writes nothing for it.
 *
 * @public
 */
export interface SetMetadataCommand {
  readonly type: "video.setMetadata";
  readonly field: keyof VideoMetadata;
  readonly value: string;
}

/**
 * Every edit to a {@link VideoPlan}: plain, structured-cloneable data
 * (ADR 0003).
 *
 * @public
 */
export type VideoCommand =
  | InsertClipsCommand
  | RemoveClipsCommand
  | RestoreClipsCommand
  | DeleteRangeCommand
  | TrimClipCommand
  | SplitClipCommand
  | MoveClipsCommand
  | SetVolumeCommand
  | SetMutedCommand
  | SetFadeCommand
  | SetTransformCommand
  | SetOutputCommand
  | RestoreOutputCommand
  | SetMetadataCommand;

/**
 * The fields each command may have. Anything else is refused as
 * `malformed-command`, as the format's JSON Schema refuses it, so that the
 * reducer accepts exactly what the schema does (sdk-core ADR 0045). A field
 * whose value is `undefined` counts as absent.
 */
const COMMAND_FIELDS: Readonly<Record<VideoCommand["type"], readonly string[]>> = {
  "video.insertClips": ["at", "clips"],
  "video.removeClips": ["keys"],
  "video.restoreClips": ["entries", "remove"],
  "video.deleteRange": ["start", "end", "keys"],
  "video.trimClip": ["key", "start", "end"],
  "video.splitClip": ["key", "at", "newKey"],
  "video.moveClips": ["keys", "to"],
  "video.setVolume": ["keys", "volumeDb"],
  "video.setMuted": ["keys", "muted"],
  "video.setFade": ["key", "edge", "duration", "curve"],
  "video.setTransform": ["keys", "transform"],
  "video.setOutput": ["output"],
  "video.restoreOutput": ["output", "clips"],
  "video.setMetadata": ["field", "value"],
};
const ENTRY_FIELDS = ["index", "clip"];

/** A valid clip, to check a change's values on before the clips it changes. */
const SAMPLE_CLIP: VideoClip = {
  key: "sample",
  source: "sample",
  start: 0,
  end: 1_000_000,
  volumeDb: 0,
  muted: false,
  fadeIn: { duration: 0, curve: "linear" },
  fadeOut: { duration: 0, curve: "linear" },
  transform: { rotation: 0, crop: null, fit: "contain" },
};

/** A command's fields before they're checked: every field any command has. */
type RawCommand = {
  readonly [Field in
    | "type"
    | "at"
    | "clips"
    | "keys"
    | "entries"
    | "remove"
    | "start"
    | "end"
    | "key"
    | "newKey"
    | "to"
    | "volumeDb"
    | "muted"
    | "edge"
    | "duration"
    | "curve"
    | "transform"
    | "output"
    | "field"
    | "value"]?: unknown;
};

/** The frames on the timeline where a clip starts or ends. */
function boundaries(plan: VideoPlan): ReadonlySet<number> {
  return new Set([...clipOffsets(plan), planFrames(plan)]);
}

/** Shortens a clip's fades to fit it, fade out first. */
function fitFades(clip: VideoClip): VideoClip {
  const length = clip.end - clip.start;
  const fadeIn = Math.min(clip.fadeIn.duration, length);
  const fadeOut = Math.min(clip.fadeOut.duration, length - fadeIn);
  if (fadeIn === clip.fadeIn.duration && fadeOut === clip.fadeOut.duration) return clip;
  return {
    ...clip,
    fadeIn: { ...clip.fadeIn, duration: fadeIn },
    fadeOut: { ...clip.fadeOut, duration: fadeOut },
  };
}

/** The entries of the clips with these keys, in ascending order of index. */
function entriesOf(plan: VideoPlan, keys: ReadonlySet<string>): VideoClipEntry[] {
  const entries: VideoClipEntry[] = [];
  for (const [index, clip] of plan.clips.entries()) {
    if (keys.has(clip.key)) entries.push({ index, clip });
  }
  return entries;
}

/**
 * Creates the reducer for {@link VideoCommand}s: a pure function that
 * applies one command and returns the command that undoes it (ADR 0003,
 * ADR 0029). It needs each source's bounds, to check ranges and crops.
 * Every clip in a plan it returns covers a whole number of output frames.
 *
 * It reads commands strictly, as data that may have been stored or sent: an
 * unknown field is refused, never dropped (sdk-core ADR 0045). An invalid
 * command throws `VideoError` with `INVALID_COMMAND` and a
 * {@link VideoCommandRejection} as `details.reason`; the reducer never
 * silently corrects one.
 *
 * @public
 */
export function createVideoReducer(
  sourceInfo: (id: string) => VideoSourceBounds | undefined,
): Reducer<VideoPlan, VideoCommand> {
  const sources = (id: string) => sourceInfo(id);
  const clipsOf = (value: unknown, rate: FrameRate) => {
    if (!Array.isArray(value)) malformed("clips must be a list");
    return value.map((clip) => readClip(clip, rate, sources));
  };
  /** The given keys as a set, failing on none, repeated or unknown ones. */
  const checkKeys = (plan: VideoPlan, value: unknown, name = "keys") => {
    const keys = keyList(value, name);
    if (keys.length === 0) reject("no-clips", "It needs at least one clip.");
    if (new Set(keys).size !== keys.length) reject("duplicate-key", "It names a clip twice.");
    const present = new Set(plan.clips.map((clip) => clip.key));
    for (const key of keys) {
      if (!present.has(key)) reject("unknown-clip", `Unknown clip "${key}".`);
    }
    return new Set(keys);
  };
  const indexOf = (plan: VideoPlan, key: unknown) => {
    if (!isKey(key)) malformed("key must be a non-empty string");
    const index = plan.clips.findIndex((clip) => clip.key === key);
    if (index < 0) reject("unknown-clip", `Unknown clip "${key}".`);
    return index;
  };
  const freshKey = (plan: VideoPlan, key: unknown): string => {
    if (!isKey(key)) malformed("A new clip's key must be a non-empty string.");
    if (plan.clips.some((clip) => clip.key === key)) {
      reject("key-taken", `A clip with the key "${key}" already exists.`);
    }
    return key;
  };

  /** Replaces clips by key with new versions, inverting with their old ones. */
  const updateClips = (
    plan: VideoPlan,
    keys: unknown,
    update: (clip: VideoClip) => VideoClip,
  ): ReturnType<Reducer<VideoPlan, VideoCommand>> => {
    const rate = plan.output.frameRate;
    // The new values' own problems first, before the keys, as a schema sees
    // them: without a source, a valid change is only missing its source.
    const shape = clipProblem(update(SAMPLE_CLIP), rate, undefined);
    if (shape !== undefined && shape !== "unknown-source") {
      reject(shape, PROBLEM_MESSAGES[shape]);
    }
    const selected = checkKeys(plan, keys);
    const clips = plan.clips.map((clip) => {
      if (!selected.has(clip.key)) return clip;
      const next = update(clip);
      checkClip(next, rate, sources);
      return next;
    });
    return {
      state: { ...plan, clips },
      inverse: { type: "video.restoreClips", entries: entriesOf(plan, selected) },
    };
  };

  const restore = (plan: VideoPlan, command: RawCommand) => {
    const rate = plan.output.frameRate;
    const remove = command.remove === undefined ? [] : keyList(command.remove, "remove");
    if (!Array.isArray(command.entries)) malformed("entries must be a list");
    const entries = command.entries.map((entry: unknown) => {
      if (!isRecord<VideoClipEntry>(entry)) malformed("an entry is an object");
      onlyFields(entry, ENTRY_FIELDS, "an entry");
      return { index: entry.index, clip: readClip(entry.clip, rate, sources) };
    });
    if (remove.length > 0) checkKeys(plan, remove, "remove");
    const present = new Set(plan.clips.map((clip) => clip.key));
    const entryKeys = entries.map((entry) => entry.clip.key);
    if (new Set([...entryKeys, ...remove]).size !== entryKeys.length + remove.length) {
      reject("duplicate-key", "It names a clip twice.");
    }
    const removed = new Set([...remove, ...entryKeys.filter((key) => present.has(key))]);
    const clips = plan.clips.filter((clip) => !removed.has(clip.key));
    let previous = -1;
    for (const entry of entries) {
      const { index } = entry;
      if (!Number.isSafeInteger(index) || (index as number) <= previous) {
        reject("invalid-index", "Restored clips need ascending indexes within the plan.");
      }
      if ((index as number) > clips.length) {
        reject("invalid-index", "Restored clips need ascending indexes within the plan.");
      }
      clips.splice(index as number, 0, entry.clip);
      previous = index as number;
    }
    return {
      state: { ...plan, clips },
      inverse: {
        type: "video.restoreClips",
        entries: entriesOf(plan, removed),
        remove: entryKeys.filter((key) => !present.has(key)),
      } as const,
    };
  };

  const split = (
    clip: VideoClip,
    frame: number,
    newKey: string,
    rate: FrameRate,
  ): [VideoClip, VideoClip] => {
    const middle = clipEnd(clip.start, frame, rate);
    const first = fitFades({ ...clip, end: middle, fadeOut: { ...clip.fadeOut, duration: 0 } });
    const second = fitFades({
      ...clip,
      key: newKey,
      start: middle,
      fadeIn: { ...clip.fadeIn, duration: 0 },
    });
    return [first, second];
  };

  /** A clip's range on the grid shrunk to drop `frames` output frames at its start. */
  const dropStart = (clip: VideoClip, frames: number, rate: FrameRate): VideoClip =>
    fitFades({ ...clip, start: clipEnd(clip.start, frames, rate) });
  /** A clip's range shrunk to its first `frames` output frames. */
  const keepStart = (clip: VideoClip, frames: number, rate: FrameRate): VideoClip =>
    fitFades({ ...clip, end: clipEnd(clip.start, frames, rate) });

  const apply = (
    plan: VideoPlan,
    input: VideoCommand,
  ): ReturnType<Reducer<VideoPlan, VideoCommand>> => {
    if (!isRecord<VideoCommand>(input)) malformed("a command is an object");
    const type = input.type;
    const fields =
      typeof type === "string" && Object.hasOwn(COMMAND_FIELDS, type)
        ? COMMAND_FIELDS[type as VideoCommand["type"]]
        : undefined;
    if (!fields) reject("unknown-command", `Unknown command "${String(type)}".`);
    onlyFields(input, ["type", ...fields], type as string);
    const command = input as RawCommand;
    const rate = plan.output.frameRate;
    switch (type as VideoCommand["type"]) {
      case "video.insertClips": {
        const at = whole(command.at, "at");
        const clips = clipsOf(command.clips, rate);
        if (clips.length === 0) reject("no-clips", "Insert at least one clip.");
        const keys = clips.map((clip) => clip.key);
        if (new Set(keys).size !== keys.length) reject("duplicate-key", "It names a clip twice.");
        for (const key of keys) freshKey(plan, key);
        if (!boundaries(plan).has(at)) {
          reject("not-a-boundary", "Clips can only be inserted where a clip starts or ends.");
        }
        const index = clipOffsets(plan).indexOf(at);
        const next = [...plan.clips];
        next.splice(index < 0 ? plan.clips.length : index, 0, ...clips);
        return {
          state: { ...plan, clips: next },
          inverse: { type: "video.removeClips", keys },
        };
      }
      case "video.removeClips": {
        const selected = checkKeys(plan, command.keys);
        return {
          state: { ...plan, clips: plan.clips.filter((clip) => !selected.has(clip.key)) },
          inverse: { type: "video.restoreClips", entries: entriesOf(plan, selected) },
        };
      }
      case "video.restoreClips":
        return restore(plan, command);
      case "video.deleteRange": {
        const total = planFrames(plan);
        const start = whole(command.start, "start");
        const end = whole(command.end, "end");
        const keys = keyList(command.keys, "keys");
        if (start >= end) reject("empty-range", "A range must be at least one frame long.");
        if (end > total) reject("frame-outside-plan", "A range must be within the plan.");
        const offsets = clipOffsets(plan);
        const affected = new Set<string>();
        const clips: VideoClip[] = [];
        let added: string | undefined;
        for (const [index, clip] of plan.clips.entries()) {
          const from = offsets[index] ?? 0;
          const frames = clipFrames(clip, rate);
          const to = from + frames;
          if (to <= start || from >= end) {
            clips.push(clip);
            continue;
          }
          affected.add(clip.key);
          if (from < start && to > end) {
            if (keys.length !== 1) {
              reject(
                "new-key-required",
                "Deleting inside a clip needs one key for its second half.",
              );
            }
            const newKey = freshKey(plan, keys[0]);
            clips.push(
              fitFades({
                ...clip,
                end: clipEnd(clip.start, start - from, rate),
                fadeOut: { ...clip.fadeOut, duration: 0 },
              }),
              fitFades({
                ...clip,
                key: newKey,
                start: clipEnd(clip.start, end - from, rate),
                fadeIn: { ...clip.fadeIn, duration: 0 },
              }),
            );
            added = newKey;
          } else if (from < start) {
            clips.push(keepStart(clip, start - from, rate));
          } else if (to > end) {
            clips.push(dropStart(clip, end - from, rate));
          }
        }
        if (added === undefined && keys.length !== 0) {
          reject("unexpected-key", "Only a range inside one clip needs a key.");
        }
        for (const clip of clips) checkClip(clip, rate, sources);
        return {
          state: { ...plan, clips },
          inverse: {
            type: "video.restoreClips",
            entries: entriesOf(plan, affected),
            remove: added === undefined ? [] : [added],
          },
        };
      }
      case "video.trimClip": {
        const start = whole(command.start, "start");
        const end = whole(command.end, "end");
        const index = indexOf(plan, command.key);
        const clip = plan.clips[index] as VideoClip;
        if (end <= start) reject("empty-range", "A trim must be at least one frame long.");
        const next = fitFades({ ...clip, start, end });
        checkClip(next, rate, sources);
        const clips = [...plan.clips];
        clips[index] = next;
        return {
          state: { ...plan, clips },
          inverse: { type: "video.restoreClips", entries: [{ index, clip }] },
        };
      }
      case "video.splitClip": {
        const at = whole(command.at, "at");
        if (!isKey(command.newKey)) malformed("newKey must be a non-empty string");
        const index = indexOf(plan, command.key);
        const clip = plan.clips[index] as VideoClip;
        const newKey = freshKey(plan, command.newKey);
        const within = at - (clipOffsets(plan)[index] ?? 0);
        if (within <= 0 || within >= clipFrames(clip, rate)) {
          reject("not-inside-clip", "A clip can only be split at a frame strictly inside it.");
        }
        const parts = split(clip, within, newKey, rate);
        for (const part of parts) checkClip(part, rate, sources);
        const clips = [...plan.clips];
        clips.splice(index, 1, ...parts);
        return {
          state: { ...plan, clips },
          inverse: { type: "video.restoreClips", entries: [{ index, clip }], remove: [newKey] },
        };
      }
      case "video.moveClips": {
        const to = whole(command.to, "to");
        const selected = checkKeys(plan, command.keys);
        const moving = plan.clips.filter((clip) => selected.has(clip.key));
        const rest: VideoPlan = {
          ...plan,
          clips: plan.clips.filter((clip) => !selected.has(clip.key)),
        };
        if (!boundaries(rest).has(to)) {
          reject("not-a-boundary", "Clips can only be moved to where a clip starts or ends.");
        }
        const index = clipOffsets(rest).indexOf(to);
        const clips = [...rest.clips];
        clips.splice(index < 0 ? clips.length : index, 0, ...moving);
        return {
          state: { ...plan, clips },
          inverse: { type: "video.restoreClips", entries: entriesOf(plan, selected) },
        };
      }
      case "video.setVolume": {
        const volumeDb = command.volumeDb as number;
        return updateClips(plan, command.keys, (clip) => ({ ...clip, volumeDb }));
      }
      case "video.setMuted": {
        const muted = command.muted as boolean;
        return updateClips(plan, command.keys, (clip) => ({ ...clip, muted }));
      }
      case "video.setTransform": {
        const transform = readTransform(command.transform);
        return updateClips(plan, command.keys, (clip) => ({ ...clip, transform }));
      }
      case "video.setFade": {
        if (command.edge !== "in" && command.edge !== "out") {
          reject("invalid-edge", "A fade's edge is in or out.");
        }
        const fade = readFade({ duration: command.duration, curve: command.curve }, "the fade");
        const field = command.edge === "in" ? "fadeIn" : "fadeOut";
        return updateClips(plan, [command.key], (clip) => ({ ...clip, [field]: fade }));
      }
      case "video.setOutput": {
        const output = readOutput(command.output);
        const next = output.frameRate;
        const clips = plan.clips.map((clip) => {
          const source = sourceInfo(clip.source);
          if (source === undefined) reject("unknown-source", `Unknown source "${clip.source}".`);
          let start = clip.start;
          let frames = Math.max(1, framesIn(clip.end - clip.start, next));
          while (frames > 1 && clipEnd(start, frames, next) > source.duration) frames -= 1;
          // Even one frame of the new grid would pass the source's end: move
          // the start back so that it ends there. Only a source shorter than
          // one frame can't fit, and the check below refuses it.
          if (clipEnd(start, frames, next) > source.duration) {
            start = Math.max(0, source.duration - frameTime(frames, next));
          }
          return fitFades({ ...clip, start, end: start + frameTime(frames, next) });
        });
        for (const clip of clips) checkClip(clip, next, sources);
        return {
          state: { ...plan, output, clips },
          inverse: { type: "video.restoreOutput", output: plan.output, clips: plan.clips },
        };
      }
      case "video.restoreOutput": {
        const output = readOutput(command.output);
        const clips = clipsOf(command.clips, output.frameRate);
        const before = plan.clips.map((clip) => clip.key);
        const after = clips.map((clip) => clip.key);
        if (before.length !== after.length || before.some((key, i) => key !== after[i])) {
          reject("invalid-order", "Restored clips must be the plan's clips, in the same order.");
        }
        return {
          state: { ...plan, output, clips },
          inverse: { type: "video.restoreOutput", output: plan.output, clips: plan.clips },
        };
      }
      case "video.setMetadata": {
        const { field } = command;
        if (!isMetadataField(field)) {
          reject(
            "unknown-metadata-field",
            "Only title, description, artist, date and comment can be set.",
          );
        }
        const value = metadataValue(command.value, field);
        return {
          state: { ...plan, metadata: { ...plan.metadata, [field]: value } },
          inverse: { type: "video.setMetadata", field, value: plan.metadata[field] },
        };
      }
    }
  };

  return (plan, command) => {
    try {
      return apply(plan, command);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      throw new VideoError("INVALID_COMMAND", error.message, {
        details: { reason: error.reason },
      });
    }
  };
}

export type { VideoCommandRejection } from "./read.js";
