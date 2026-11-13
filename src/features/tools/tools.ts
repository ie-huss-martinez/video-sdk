import { defineTool, type Tool } from "@hussmartinez/sdk-core";
import { clipFrames, clipOffsets, planFrames, type VideoPlan } from "../../core/model/plan.js";
import type { VideoCommand } from "../../core/operations/commands.js";

/**
 * What the editor's tools read to decide whether they're available, enabled
 * or on (docs/adr/0007). It's derived from the session, the output and the
 * timeline's view state, and rebuilt when any of them changes.
 *
 * @internal
 */
export interface VideoToolState {
  readonly plan: VideoPlan | null;
  /** The selected clips' keys, in plan order. */
  readonly selectedClips: readonly string[];
  /** The playhead, in output frames. */
  readonly playhead: number;
  readonly playing: boolean;
  /** Whether there's an output to play into. */
  readonly canPlay: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The timeline's zoom, as a multiple of fitting the whole plan: 1 fits it. */
  readonly zoom: number;
  /** The closest zoom the timeline allows now. */
  readonly maxZoom: number;
}

/**
 * What a tool's `run` receives: the state it was enabled for, and the
 * editor's actions (docs/adr/0007).
 *
 * @internal
 */
export interface VideoToolContext {
  readonly state: VideoToolState;
  /** Runs commands as one undoable step. A refused edit is in the session's snapshot. */
  execute(commands: VideoCommand | readonly VideoCommand[]): void;
  undo(): void;
  redo(): void;
  play(): void;
  pause(): void;
  seek(frame: number): void;
  step(delta: -1 | 1): void;
  setZoom(zoom: number): void;
  /** Opens the file picker to add videos at the end. */
  chooseFiles(): void;
  /** A key for a new clip, from the session: unique in the plan and its history. */
  newClipKey(): string;
}

/**
 * One of the editor's tools.
 *
 * @internal
 */
export type VideoTool = Tool<VideoToolState, VideoToolContext>;

/** Each zoom step multiplies or divides the timeline's zoom by this. */
export const ZOOM_STEP = 1.5;

const frames = (state: VideoToolState) => (state.plan ? planFrames(state.plan) : 0);
const playable = (state: VideoToolState) => state.canPlay && frames(state) > 0;
const selected = (state: VideoToolState) => state.selectedClips.length > 0;

/** The clip strictly around the playhead, which a split would cut, if any. */
export function clipToSplit(
  state: VideoToolState,
): { readonly key: string; readonly at: number } | undefined {
  const plan = state.plan;
  if (!plan) return undefined;
  const offsets = clipOffsets(plan);
  const rate = plan.output.frameRate;
  for (const [index, clip] of plan.clips.entries()) {
    const start = offsets[index] ?? 0;
    if (state.playhead > start && state.playhead < start + clipFrames(clip, rate)) {
      return { key: clip.key, at: state.playhead };
    }
  }
  return undefined;
}

/** Whether every selected clip is muted. */
const allMuted = (state: VideoToolState) =>
  selected(state) &&
  state.selectedClips.every((key) => state.plan?.clips.find((clip) => clip.key === key)?.muted);

/**
 * Every tool the video editor knows, in order (docs/adr/0007). The editor
 * builds its toolbar and shortcuts from them, with sdk-core's registries.
 *
 * @internal
 */
export const videoTools: readonly VideoTool[] = [
  defineTool({
    id: "video.insert",
    label: "tools.insert",
    icon: "add",
    group: "file",
    run: (context: VideoToolContext) => context.chooseFiles(),
  }),
  defineTool({
    id: "video.undo",
    label: "tools.undo",
    icon: "undo",
    group: "history",
    shortcuts: "undo",
    isEnabled: (state: VideoToolState) => state.canUndo,
    run: (context: VideoToolContext) => context.undo(),
  }),
  defineTool({
    id: "video.redo",
    label: "tools.redo",
    icon: "redo",
    group: "history",
    shortcuts: "redo",
    isEnabled: (state: VideoToolState) => state.canRedo,
    run: (context: VideoToolContext) => context.redo(),
  }),
  defineTool({
    id: "video.split",
    label: "tools.split",
    icon: "split",
    group: "edit",
    shortcuts: ["S"],
    isEnabled: (state: VideoToolState) => clipToSplit(state) !== undefined,
    run: (context: VideoToolContext) => {
      const target = clipToSplit(context.state);
      if (target) {
        context.execute({ type: "video.splitClip", ...target, newKey: context.newClipKey() });
      }
    },
  }),
  defineTool({
    id: "video.delete",
    label: "tools.delete",
    icon: "delete",
    group: "edit",
    shortcuts: "delete",
    isEnabled: selected,
    run: (context: VideoToolContext) =>
      context.execute({ type: "video.removeClips", keys: context.state.selectedClips }),
  }),
  defineTool({
    id: "video.mute",
    label: "tools.mute",
    icon: "muted",
    group: "edit",
    shortcuts: ["M"],
    isEnabled: selected,
    isActive: allMuted,
    run: (context: VideoToolContext) =>
      context.execute({
        type: "video.setMuted",
        keys: context.state.selectedClips,
        muted: !allMuted(context.state),
      }),
  }),
  defineTool({
    id: "video.play-pause",
    label: "tools.playPause",
    icon: "play",
    group: "playback",
    shortcuts: "play-pause",
    isEnabled: playable,
    isActive: (state: VideoToolState) => state.playing,
    run: (context: VideoToolContext) => (context.state.playing ? context.pause() : context.play()),
  }),
  defineTool({
    id: "video.previous-frame",
    label: "tools.previousFrame",
    icon: "chevron-left",
    group: "playback",
    shortcuts: [{ keys: "ArrowLeft", repeat: true }],
    isEnabled: playable,
    run: (context: VideoToolContext) => context.step(-1),
  }),
  defineTool({
    id: "video.next-frame",
    label: "tools.nextFrame",
    icon: "chevron-right",
    group: "playback",
    shortcuts: [{ keys: "ArrowRight", repeat: true }],
    isEnabled: playable,
    run: (context: VideoToolContext) => context.step(1),
  }),
  defineTool({
    id: "video.start",
    label: "tools.start",
    icon: "skip-back",
    group: "playback",
    shortcuts: ["Home"],
    isEnabled: playable,
    run: (context: VideoToolContext) => context.seek(0),
  }),
  defineTool({
    id: "video.end",
    label: "tools.end",
    icon: "skip-forward",
    group: "playback",
    shortcuts: ["End"],
    isEnabled: playable,
    run: (context: VideoToolContext) => context.seek(Math.max(0, frames(context.state) - 1)),
  }),
  defineTool({
    id: "video.zoom-out",
    label: "tools.zoomOut",
    icon: "zoom-out",
    group: "view",
    shortcuts: "zoom-out",
    isEnabled: (state: VideoToolState) => frames(state) > 0 && state.zoom > 1,
    run: (context: VideoToolContext) =>
      context.setZoom(Math.max(1, context.state.zoom / ZOOM_STEP)),
  }),
  defineTool({
    id: "video.zoom-in",
    label: "tools.zoomIn",
    icon: "zoom-in",
    group: "view",
    shortcuts: "zoom-in",
    isEnabled: (state: VideoToolState) => frames(state) > 0 && state.zoom < state.maxZoom,
    run: (context: VideoToolContext) =>
      context.setZoom(Math.min(context.state.maxZoom, context.state.zoom * ZOOM_STEP)),
  }),
  defineTool({
    id: "video.zoom-fit",
    label: "tools.zoomFit",
    icon: "fit",
    group: "view",
    shortcuts: "zoom-reset",
    isEnabled: (state: VideoToolState) => frames(state) > 0 && state.zoom > 1,
    run: (context: VideoToolContext) => context.setZoom(1),
  }),
];

/**
 * The editor's toolbar by default: editing and the view. Playback has its
 * own controls, the transport, and its tools keep their keys.
 *
 * @internal
 */
export const defaultVideoToolbar: readonly (readonly string[])[] = [
  ["video.insert"],
  ["video.undo", "video.redo"],
  ["video.split", "video.delete", "video.mute"],
  ["video.zoom-out", "video.zoom-in", "video.zoom-fit"],
];
