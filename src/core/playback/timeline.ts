import { clipFrames, planFrames, type VideoPlan } from "../model/plan.js";
import { frameTime } from "../model/time.js";

/**
 * "Media time `media` is heard at wall-clock time `at`" (docs/adr/0006): the
 * one mapping the page and the worker both read playback's clock from.
 * `media` is in microseconds on the plan's timeline; `at` is in milliseconds
 * since the epoch, as `performance.timeOrigin + performance.now()`, which a
 * page and its workers agree on although their `performance.now()` don't.
 *
 * @internal
 */
export interface PlaybackAnchor {
  readonly media: number;
  readonly at: number;
}

/**
 * How far before a cut the next clip's decoder starts, in microseconds
 * (docs/adr/0006), so its first frame is ready at the cut.
 *
 * @internal
 */
export const PREROLL = 1_000_000;

/**
 * Media time at wall-clock time `now`: `media + (now − at) × 1,000`.
 *
 * @internal
 */
export function mediaTimeAt(anchor: PlaybackAnchor, now: number): number {
  return anchor.media + (now - anchor.at) * 1_000;
}

/** Whether two anchors are the same mapping. */
export function sameAnchor(a: PlaybackAnchor | null, b: PlaybackAnchor | null): boolean {
  return a === b || (a !== null && b !== null && a.media === b.media && a.at === b.at);
}

/**
 * Where each clip starts on the timeline, in microseconds, and where the
 * plan ends, as the last entry.
 *
 * @internal
 */
export function clipStarts(plan: VideoPlan): readonly number[] {
  const starts: number[] = [];
  let frames = 0;
  for (const clip of plan.clips) {
    starts.push(frameTime(frames, plan.output.frameRate));
    frames += clipFrames(clip, plan.output.frameRate);
  }
  starts.push(frameTime(frames, plan.output.frameRate));
  return starts;
}

/**
 * The index of the clip playing at timeline time `time`, given
 * {@link clipStarts}: the last clip that starts at or before it, or the last
 * clip at or past the end. `-1` for a plan without clips.
 *
 * @internal
 */
export function clipAt(starts: readonly number[], time: number): number {
  const clips = starts.length - 1;
  let index = clips - 1;
  while (index > 0 && (starts[index] as number) > time) index -= 1;
  return index;
}

/**
 * The output frame being shown at timeline time `time`: the last frame that
 * starts at or before it, within `[0, planFrames(plan)]`.
 *
 * @internal
 */
export function frameAt(plan: VideoPlan, time: number): number {
  const { num, den } = plan.output.frameRate;
  const length = planFrames(plan);
  let frame = Math.floor((time * num) / (1_000_000 * den));
  // frameTime rounds to whole microseconds, so a frame can start up to half
  // a microsecond either side of where the division puts it.
  if (frameTime(frame + 1, plan.output.frameRate) <= time) frame += 1;
  else if (frame > 0 && frameTime(frame, plan.output.frameRate) > time) frame -= 1;
  return Math.max(0, Math.min(frame, length));
}

/**
 * The frame that stepping by `delta` from `position` shows (docs/adr/0006),
 * or `undefined` past either end. A playhead at the end shows the last
 * frame, so stepping back from it shows the one before.
 *
 * @internal
 */
export function stepTarget(position: number, delta: number, length: number): number | undefined {
  if (length === 0) return undefined;
  const target = Math.min(position, length - 1) + delta;
  return target < 0 || target > length - 1 ? undefined : target;
}
