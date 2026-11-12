import { VideoError } from "../errors/video-error.js";
import {
  clipEnd,
  clipFrames,
  clipOffsets,
  clipProblem,
  MAX_METADATA_LENGTH,
  outputProblem,
  planFrames,
  type VideoClip,
  type VideoFadeCurve,
  type VideoMetadata,
  type VideoPlan,
  type VideoPlanOutput,
  type VideoTransform,
} from "../model/plan.js";
import type { VideoSourceInfo } from "../model/source.js";
import { type FrameRate, framesIn, frameTime, isWhole } from "../model/time.js";
import type { Reducer } from "./reducer-types.js";

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
 * and its fades are shortened to fit. `clips`, which undo uses, puts clips
 * back exactly as they were instead.
 *
 * @public
 */
export interface SetOutputCommand {
  readonly type: "video.setOutput";
  readonly output: VideoPlanOutput;
  readonly clips?: readonly VideoClip[];
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
  | SetMetadataCommand;

const METADATA_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "artist",
  "date",
  "comment",
]);

function invalid(message: string): VideoError {
  return new VideoError("INVALID_COMMAND", message);
}

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
 * ADR 0029). It needs each source's summary, to check ranges and crops.
 * Every clip in a plan it returns covers a whole number of output frames.
 * An invalid command throws `VideoError` with `INVALID_COMMAND`; the reducer
 * never silently corrects one.
 *
 * @public
 */
export function createVideoReducer(
  sourceInfo: (id: string) => VideoSourceInfo | undefined,
): Reducer<VideoPlan, VideoCommand> {
  const checkClip = (clip: VideoClip, rate: FrameRate) => {
    const problem = clipProblem(clip, rate, sourceInfo(clip.source));
    if (problem !== undefined) throw invalid(problem);
  };
  const checkKeys = (plan: VideoPlan, keys: readonly string[]) => {
    const present = new Set(plan.clips.map((clip) => clip.key));
    if (new Set(keys).size !== keys.length) throw invalid("A command names a clip twice.");
    for (const key of keys) {
      if (!present.has(key)) throw invalid(`Unknown clip "${key}".`);
    }
    return new Set(keys);
  };
  const indexOf = (plan: VideoPlan, key: string) => {
    const index = plan.clips.findIndex((clip) => clip.key === key);
    if (index < 0) throw invalid(`Unknown clip "${key}".`);
    return index;
  };
  const freshKey = (plan: VideoPlan, key: string) => {
    if (typeof key !== "string" || key === "") throw invalid("A new clip needs a key.");
    if (plan.clips.some((clip) => clip.key === key)) {
      throw invalid(`A clip with the key "${key}" already exists.`);
    }
  };

  /** Replaces clips by key with new versions, inverting with their old ones. */
  const updateClips = (
    plan: VideoPlan,
    keys: readonly string[],
    update: (clip: VideoClip) => VideoClip,
  ) => {
    const selected = checkKeys(plan, keys);
    const rate = plan.output.frameRate;
    const clips = plan.clips.map((clip) => {
      if (!selected.has(clip.key)) return clip;
      const next = update(clip);
      checkClip(next, rate);
      return next;
    });
    return {
      state: { ...plan, clips },
      inverse: { type: "video.restoreClips", entries: entriesOf(plan, selected) } as const,
    };
  };

  const restore = (plan: VideoPlan, command: RestoreClipsCommand) => {
    const rate = plan.output.frameRate;
    const remove = command.remove ?? [];
    checkKeys(plan, remove);
    const present = new Set(plan.clips.map((clip) => clip.key));
    const entryKeys = command.entries.map((entry) => entry.clip.key);
    if (new Set([...entryKeys, ...remove]).size !== entryKeys.length + remove.length) {
      throw invalid("A command names a clip twice.");
    }
    const removed = new Set([...remove, ...entryKeys.filter((key) => present.has(key))]);
    const clips = plan.clips.filter((clip) => !removed.has(clip.key));
    let previous = -1;
    for (const entry of command.entries) {
      if (!isWhole(entry.index) || entry.index <= previous || entry.index > clips.length) {
        throw invalid("Restored clips need ascending indexes within the plan.");
      }
      checkClip(entry.clip, rate);
      clips.splice(entry.index, 0, entry.clip);
      previous = entry.index;
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

  return (plan, command): ReturnType<Reducer<VideoPlan, VideoCommand>> => {
    const rate = plan.output.frameRate;
    switch (command.type) {
      case "video.insertClips": {
        if (!boundaries(plan).has(command.at)) {
          throw invalid("Clips can only be inserted where a clip starts or ends.");
        }
        if (command.clips.length === 0) throw invalid("Insert at least one clip.");
        const keys = command.clips.map((clip) => clip.key);
        if (new Set(keys).size !== keys.length) throw invalid("A command names a clip twice.");
        for (const clip of command.clips) {
          freshKey(plan, clip.key);
          checkClip(clip, rate);
        }
        const index = clipOffsets(plan).indexOf(command.at);
        const at = index < 0 ? plan.clips.length : index;
        const clips = [...plan.clips];
        clips.splice(at, 0, ...command.clips);
        return {
          state: { ...plan, clips },
          inverse: { type: "video.removeClips", keys },
        };
      }
      case "video.removeClips": {
        if (command.keys.length === 0) throw invalid("Remove at least one clip.");
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
        const { start, end } = command;
        if (!isWhole(start) || !isWhole(end) || start >= end || end > total) {
          throw invalid("A range must be whole frames within the plan, at least one long.");
        }
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
            if (command.keys.length !== 1) {
              throw invalid("Deleting inside a clip needs one key for its second half.");
            }
            const newKey = command.keys[0] as string;
            freshKey(plan, newKey);
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
        if (added === undefined && command.keys.length !== 0) {
          throw invalid("Only a range inside one clip needs a key.");
        }
        for (const clip of clips) checkClip(clip, rate);
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
        const index = indexOf(plan, command.key);
        const clip = plan.clips[index] as VideoClip;
        if (!isWhole(command.start) || !isWhole(command.end) || command.end <= command.start) {
          throw invalid("A trim must be whole microseconds, at least one frame long.");
        }
        const next = fitFades({ ...clip, start: command.start, end: command.end });
        checkClip(next, rate);
        const clips = [...plan.clips];
        clips[index] = next;
        return {
          state: { ...plan, clips },
          inverse: { type: "video.restoreClips", entries: [{ index, clip }] },
        };
      }
      case "video.splitClip": {
        const index = indexOf(plan, command.key);
        const clip = plan.clips[index] as VideoClip;
        freshKey(plan, command.newKey);
        const within = command.at - (clipOffsets(plan)[index] ?? 0);
        if (!isWhole(command.at) || within <= 0 || within >= clipFrames(clip, rate)) {
          throw invalid("A clip can only be split at a frame strictly inside it.");
        }
        const parts = split(clip, within, command.newKey, rate);
        for (const part of parts) checkClip(part, rate);
        const clips = [...plan.clips];
        clips.splice(index, 1, ...parts);
        return {
          state: { ...plan, clips },
          inverse: {
            type: "video.restoreClips",
            entries: [{ index, clip }],
            remove: [command.newKey],
          },
        };
      }
      case "video.moveClips": {
        if (command.keys.length === 0) throw invalid("Move at least one clip.");
        const selected = checkKeys(plan, command.keys);
        const moving = plan.clips.filter((clip) => selected.has(clip.key));
        const rest: VideoPlan = {
          ...plan,
          clips: plan.clips.filter((clip) => !selected.has(clip.key)),
        };
        if (!boundaries(rest).has(command.to)) {
          throw invalid("Clips can only be moved to where a clip starts or ends.");
        }
        const index = clipOffsets(rest).indexOf(command.to);
        const clips = [...rest.clips];
        clips.splice(index < 0 ? clips.length : index, 0, ...moving);
        return {
          state: { ...plan, clips },
          inverse: { type: "video.restoreClips", entries: entriesOf(plan, selected) },
        };
      }
      case "video.setVolume":
        return updateClips(plan, command.keys, (clip) => ({ ...clip, volumeDb: command.volumeDb }));
      case "video.setMuted":
        return updateClips(plan, command.keys, (clip) => ({ ...clip, muted: command.muted }));
      case "video.setTransform":
        return updateClips(plan, command.keys, (clip) => ({
          ...clip,
          transform: command.transform,
        }));
      case "video.setFade": {
        if (command.edge !== "in" && command.edge !== "out") {
          throw invalid("A fade's edge is in or out.");
        }
        const field = command.edge === "in" ? "fadeIn" : "fadeOut";
        return updateClips(plan, [command.key], (clip) => ({
          ...clip,
          [field]: { duration: command.duration, curve: command.curve },
        }));
      }
      case "video.setOutput": {
        const problem = outputProblem(command.output);
        if (problem !== undefined) throw invalid(problem);
        const next = command.output.frameRate;
        let clips: readonly VideoClip[];
        if (command.clips !== undefined) {
          const before = plan.clips.map((clip) => clip.key);
          const after = command.clips.map((clip) => clip.key);
          if (before.length !== after.length || before.some((key, i) => key !== after[i])) {
            throw invalid("Restored clips must be the plan's clips, in the same order.");
          }
          clips = command.clips;
        } else {
          clips = plan.clips.map((clip) => {
            const source = sourceInfo(clip.source);
            if (source === undefined) throw invalid(`Unknown source "${clip.source}".`);
            let frames = Math.max(1, framesIn(clip.end - clip.start, next));
            while (frames > 1 && clipEnd(clip.start, frames, next) > source.duration) frames -= 1;
            return fitFades({ ...clip, end: clip.start + frameTime(frames, next) });
          });
        }
        for (const clip of clips) checkClip(clip, next);
        return {
          state: { ...plan, output: command.output, clips },
          inverse: { type: "video.setOutput", output: plan.output, clips: plan.clips },
        };
      }
      case "video.setMetadata":
        if (!METADATA_FIELDS.has(command.field)) {
          throw invalid("Only title, description, artist, date and comment can be set.");
        }
        if (typeof command.value !== "string" || command.value.length > MAX_METADATA_LENGTH) {
          throw invalid(
            `A metadata value must be text of at most ${MAX_METADATA_LENGTH} characters.`,
          );
        }
        return {
          state: { ...plan, metadata: { ...plan.metadata, [command.field]: command.value } },
          inverse: {
            type: "video.setMetadata",
            field: command.field,
            value: plan.metadata[command.field],
          },
        };
      default:
        throw invalid(`Unknown command "${(command as { type?: unknown }).type}".`);
    }
  };
}
