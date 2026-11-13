import { sequenceOffsets } from "@hussmartinez/sdk-core";
import { clipEnd, clipFrames, type VideoPlan } from "../core/model/plan.js";
import { framesIn, frameTime } from "../core/model/time.js";

/**
 * Where `video.moveClips` should take the selected clips for one step left
 * or right (docs/adr/0007): to the start of the clip before them, or the end
 * of the clip after them, in the plan without them. `undefined` when they're
 * already at that end, or nothing is selected.
 *
 * @internal
 */
export function moveTarget(
  plan: VideoPlan,
  keys: readonly string[],
  direction: -1 | 1,
): number | undefined {
  const selected = new Set(keys);
  const first = plan.clips.findIndex((clip) => selected.has(clip.key));
  if (first < 0) return undefined;
  const remaining = plan.clips.filter((clip) => !selected.has(clip.key));
  // In the plan without them, the selected clips sit before remaining[first - (moved before)].
  const before = plan.clips.slice(0, first).filter((clip) => !selected.has(clip.key)).length;
  const target = before + direction;
  if (target < 0 || target > remaining.length) return undefined;
  let to = 0;
  for (const clip of remaining.slice(0, target)) to += clipFrames(clip, plan.output.frameRate);
  return to;
}

/** A clip's new source range, for `video.trimClip`. */
export interface TrimRange {
  readonly start: number;
  readonly end: number;
}

/** A clip's edge: its first frame, or the end after its last. */
export type ClipEdge = "start" | "end";

/**
 * The range of clip `index` with one edge moved by `delta` frames
 * (docs/adr/0007): a positive `delta` lengthens the clip at that edge, and a
 * negative one shortens it. The start moves on the clip's own frame grid, so
 * the frame now first is one the clip already showed, or one before it.
 * `undefined` when the clip would be under one frame, or start before its
 * source does. A range past the source's end is refused by the session; see
 * {@link edgeLimits}.
 *
 * @internal
 */
export function trimEdge(
  plan: VideoPlan,
  index: number,
  edge: ClipEdge,
  delta: number,
): TrimRange | undefined {
  const clip = plan.clips[index];
  if (!clip || !Number.isSafeInteger(delta)) return undefined;
  const rate = plan.output.frameRate;
  const frames = clipFrames(clip, rate) + delta;
  if (frames < 1) return undefined;
  if (edge === "end") return { start: clip.start, end: clipEnd(clip.start, frames, rate) };
  const start =
    delta <= 0 ? clip.start + frameTime(-delta, rate) : clip.start - frameTime(delta, rate);
  return start < 0 ? undefined : { start, end: clip.end };
}

/**
 * How far an edge of clip `index` can move, in frames, as {@link trimEdge}'s
 * `delta`: down to a one-frame clip, and up to its source's start or end.
 *
 * @internal
 */
export function edgeLimits(
  plan: VideoPlan,
  index: number,
  edge: ClipEdge,
  sourceDuration: number,
): { readonly min: number; readonly max: number } {
  const clip = plan.clips[index];
  if (!clip) return { min: 0, max: 0 };
  const rate = plan.output.frameRate;
  const frames = clipFrames(clip, rate);
  const room =
    edge === "start"
      ? Math.floor((clip.start * rate.num) / (1_000_000 * rate.den))
      : Math.max(0, framesIn(sourceDuration - clip.start, rate) - frames);
  // framesIn rounds; the end must stay at or before the source's.
  const max =
    edge === "end" && clipEnd(clip.start, frames + room, rate) > sourceDuration + 1
      ? Math.max(0, room - 1)
      : room;
  return { min: 1 - frames, max };
}

/**
 * The range of clip `index` with one edge set to the playhead (docs/adr/0007),
 * or `undefined` when the playhead isn't strictly inside the clip.
 *
 * @internal
 */
export function trimToPlayhead(
  plan: VideoPlan,
  index: number,
  playhead: number,
  edge: ClipEdge,
): TrimRange | undefined {
  const clip = plan.clips[index];
  const offset = offsetsOf(plan)[index];
  if (!clip || offset === undefined) return undefined;
  const frames = clipFrames(clip, plan.output.frameRate);
  const within = playhead - offset;
  if (within < 1 || within >= frames) return undefined;
  return trimEdge(plan, index, edge, edge === "start" ? -within : within - frames);
}

/**
 * Every clip boundary on the timeline, in output frames: the clips' starts,
 * then the plan's length, from sdk-core's `sequenceOffsets` (ADR 0042).
 *
 * @internal
 */
export function offsetsOf(plan: VideoPlan): readonly number[] {
  return sequenceOffsets(plan.clips.map((clip) => clipFrames(clip, plan.output.frameRate)));
}

/**
 * The keys from `anchor` to `focus`, inclusive, in plan order: a range
 * selection made with Shift.
 *
 * @internal
 */
export function selectRange(plan: VideoPlan, anchor: number, focus: number): string[] {
  const [from, to] = anchor <= focus ? [anchor, focus] : [focus, anchor];
  return plan.clips.slice(from, to + 1).map((clip) => clip.key);
}
