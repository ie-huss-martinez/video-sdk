import type { VideoClip, VideoFadeCurve, VideoPlan } from "../../core/model/plan.js";
import type { VideoSourceInfo } from "../../core/model/source.js";
import type { VideoCommand } from "../../core/operations/commands.js";

/**
 * One edge's fade over the selected clips, for the inspector
 * (docs/adr/0008).
 *
 * @internal
 */
export interface ClipFadeState {
  /** The fade's length in microseconds, or `null` when the clips differ. */
  readonly duration: number | null;
  /** The fade's curve, or `null` when the clips differ. */
  readonly curve: VideoFadeCurve | null;
  /**
   * The longest this fade can be on every selected clip, in microseconds:
   * the shortest of what each has left beside its other fade.
   */
  readonly max: number;
}

/**
 * The sound of the selected clips, as the inspector shows it
 * (docs/adr/0008): one value where the clips agree, and `null` where they
 * differ.
 *
 * @internal
 */
export interface ClipAudioState {
  /** The selected clips that are in the plan, in plan order. */
  readonly keys: readonly string[];
  /**
   * The first of them, whose values a control shows when the clips differ,
   * or `null` when none is selected.
   */
  readonly lead: VideoClip | null;
  /** Whether any of them has sound to change. */
  readonly hasAudio: boolean;
  readonly volumeDb: number | null;
  readonly muted: boolean | null;
  readonly fadeIn: ClipFadeState;
  readonly fadeOut: ClipFadeState;
}

/** The one value every item has, or `null` when they differ or there are none. */
function shared<T>(values: readonly T[]): T | null {
  const [first] = values;
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

const lengthOf = (clip: VideoClip) => clip.end - clip.start;

/** The clip's fade at an edge, and the one at its other edge. */
const fadesOf = (clip: VideoClip, edge: "in" | "out") =>
  edge === "in"
    ? { fade: clip.fadeIn, other: clip.fadeOut }
    : { fade: clip.fadeOut, other: clip.fadeIn };

function fadeState(clips: readonly VideoClip[], edge: "in" | "out"): ClipFadeState {
  return {
    duration: shared(clips.map((clip) => fadesOf(clip, edge).fade.duration)),
    curve: shared(clips.map((clip) => fadesOf(clip, edge).fade.curve)),
    max: clips.length
      ? Math.min(...clips.map((clip) => lengthOf(clip) - fadesOf(clip, edge).other.duration))
      : 0,
  };
}

/**
 * Reads the selected clips' sound from the plan (docs/adr/0008).
 *
 * @param selected - The selected clips' keys. Keys the plan doesn't have are left out.
 * @internal
 */
export function clipAudioState(
  plan: VideoPlan | null,
  sources: readonly VideoSourceInfo[],
  selected: readonly string[],
): ClipAudioState {
  const chosen = new Set(selected);
  const clips = plan?.clips.filter((clip) => chosen.has(clip.key)) ?? [];
  const withAudio = new Set(sources.filter((source) => source.audio).map((source) => source.id));
  return {
    keys: clips.map((clip) => clip.key),
    lead: clips[0] ?? null,
    hasAudio: clips.some((clip) => withAudio.has(clip.source)),
    volumeDb: shared(clips.map((clip) => clip.volumeDb)),
    muted: shared(clips.map((clip) => clip.muted)),
    fadeIn: fadeState(clips, "in"),
    fadeOut: fadeState(clips, "out"),
  };
}

/**
 * The commands that set a fade on the selected clips, as one undo step.
 * Each clip takes the new length, kept within what it has left beside its
 * other fade, and the new curve; what isn't given stays as each clip has it.
 * The reducer refuses a fade that doesn't fit, so the clamp is here
 * (docs/adr/0003).
 *
 * @param change - The new length, in microseconds, the new curve, or both.
 * @internal
 */
export function fadeCommands(
  plan: VideoPlan,
  keys: readonly string[],
  edge: "in" | "out",
  change: { readonly duration?: number; readonly curve?: VideoFadeCurve },
): VideoCommand[] {
  const chosen = new Set(keys);
  return plan.clips
    .filter((clip) => chosen.has(clip.key))
    .map((clip) => {
      const { fade, other } = fadesOf(clip, edge);
      const most = lengthOf(clip) - other.duration;
      const duration = Math.round(Math.min(Math.max(change.duration ?? fade.duration, 0), most));
      return {
        type: "video.setFade",
        key: clip.key,
        edge,
        duration,
        curve: change.curve ?? fade.curve,
      } satisfies VideoCommand;
    });
}
