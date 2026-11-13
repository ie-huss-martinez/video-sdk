import { createShortcutRegistry, createToolRegistry, type Platform } from "@hussmartinez/sdk-core";
import { describe, expect, it, vi } from "vitest";
import {
  clipEnd,
  createPlan,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoPlan,
} from "../../core/model/plan.js";
import type { VideoCommand } from "../../core/operations/commands.js";
import {
  clipToSplit,
  defaultVideoToolbar,
  type VideoToolContext,
  type VideoToolState,
  videoTools,
} from "./tools.js";

const RATE = { num: 30, den: 1 };

function clip(key: string, frames: number, muted = false): VideoClip {
  return {
    key,
    source: "s",
    start: 0,
    end: clipEnd(0, frames, RATE),
    volumeDb: 0,
    muted,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

const plan: VideoPlan = {
  ...createPlan({ width: 64, height: 36, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
  clips: [clip("a", 30), clip("b", 30, true)],
};

const state = (changes: Partial<VideoToolState> = {}): VideoToolState => ({
  plan,
  selectedClips: [],
  playhead: 0,
  playing: false,
  canPlay: true,
  canUndo: false,
  canRedo: false,
  zoom: 1,
  maxZoom: 4,
  ...changes,
});

function contextFor(current: VideoToolState) {
  const executed: VideoCommand[] = [];
  const context: VideoToolContext = {
    state: current,
    execute: (commands) => {
      executed.push(...(Array.isArray(commands) ? commands : [commands as VideoCommand]));
    },
    undo: vi.fn(),
    redo: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    step: vi.fn(),
    setZoom: vi.fn(),
    chooseFiles: vi.fn(),
    openExport: vi.fn(),
    newClipKey: () => "new",
  };
  return { context, executed };
}

const tool = (id: string) => {
  const found = videoTools.find((each) => each.id === id);
  if (!found) throw new Error(`no tool ${id}`);
  return found;
};

describe("the video editor's tools", () => {
  it("register with sdk-core, with the default toolbar, and no two share a key on either platform", () => {
    const registry = createToolRegistry(videoTools, { toolbar: defaultVideoToolbar });
    expect(registry.toolbar.map((group) => group.map((each) => each.id))).toEqual(
      defaultVideoToolbar,
    );
    for (const platform of ["apple", "other"] as Platform[]) {
      expect(() => createShortcutRegistry({ platform, tools: registry.tools })).not.toThrow();
    }
  });

  it("match the family's keys and their own (docs/adr/0007)", () => {
    const keys = createShortcutRegistry({ platform: "other", tools: videoTools });
    const apple = createShortcutRegistry({ platform: "apple", tools: videoTools });
    const press = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      code: "",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      target: null,
      ...extra,
    });
    expect(keys.match(press("s"))).toBe("video.split");
    expect(keys.match(press("m"))).toBe("video.mute");
    expect(keys.match(press(" "))).toBe("video.play-pause");
    expect(keys.match(press("Delete"))).toBe("video.delete");
    expect(keys.match(press("+", { shiftKey: true }))).toBe("video.zoom-in");
    expect(keys.match(press("-"))).toBe("video.zoom-out");
    expect(keys.match(press("0"))).toBe("video.zoom-fit");
    expect(keys.match(press("ArrowLeft"))).toBe("video.previous-frame");
    expect(keys.match(press("End"))).toBe("video.end");
    expect(keys.match(press("z", { ctrlKey: true }))).toBe("video.undo");
    expect(apple.match(press("z", { metaKey: true }))).toBe("video.undo");
    expect(apple.match(press("z", { metaKey: true, shiftKey: true }))).toBe("video.redo");
    // The browser's page zoom stays the browser's (sdk-core ADR 0030).
    expect(keys.match(press("+", { ctrlKey: true, shiftKey: true }))).toBeUndefined();
    // Holding an arrow steps frame by frame; holding S doesn't split again.
    expect(keys.match(press("ArrowRight", { repeat: true }))).toBe("video.next-frame");
    expect(keys.match(press("s", { repeat: true }))).toBeUndefined();
  });

  it("split the clip strictly around the playhead, and only there", () => {
    expect(clipToSplit(state({ playhead: 10 }))).toEqual({ key: "a", at: 10 });
    expect(clipToSplit(state({ playhead: 30 }))).toBeUndefined();
    expect(clipToSplit(state({ playhead: 0 }))).toBeUndefined();
    const split = tool("video.split");
    expect(split.isEnabled?.(state({ playhead: 30 }))).toBe(false);
    const { context, executed } = contextFor(state({ playhead: 45 }));
    split.run(context);
    expect(executed).toEqual([{ type: "video.splitClip", key: "b", at: 45, newKey: "new" }]);
  });

  it("export through the dialog only, with no keys, once there's something to export", () => {
    const exporter = tool("video.export");
    expect(exporter.shortcuts).toBeUndefined();
    expect(exporter.isEnabled?.(state({ plan: { ...plan, clips: [] } }))).toBe(false);
    expect(exporter.isEnabled?.(state())).toBe(true);
    const { context } = contextFor(state());
    exporter.run(context);
    expect(context.openExport).toHaveBeenCalled();
  });

  it("delete and mute the selection, and mute shows on when every selected clip is muted", () => {
    const mute = tool("video.mute");
    expect(tool("video.delete").isEnabled?.(state())).toBe(false);
    expect(mute.isActive?.(state({ selectedClips: ["b"] }))).toBe(true);
    expect(mute.isActive?.(state({ selectedClips: ["a", "b"] }))).toBe(false);
    const { context, executed } = contextFor(state({ selectedClips: ["a", "b"] }));
    mute.run(context);
    tool("video.delete").run(context);
    expect(executed).toEqual([
      { type: "video.setMuted", keys: ["a", "b"], muted: true },
      { type: "video.removeClips", keys: ["a", "b"] },
    ]);
  });

  it("zoom between fitting the plan and the timeline's closest zoom", () => {
    expect(tool("video.zoom-out").isEnabled?.(state())).toBe(false);
    expect(tool("video.zoom-in").isEnabled?.(state({ zoom: 4 }))).toBe(false);
    const { context } = contextFor(state({ zoom: 3 }));
    tool("video.zoom-in").run(context);
    expect(context.setZoom).toHaveBeenCalledWith(4);
    const empty = state({ plan: { ...plan, clips: [] } });
    expect(tool("video.zoom-in").isEnabled?.(empty)).toBe(false);
    expect(tool("video.play-pause").isEnabled?.(empty)).toBe(false);
  });
});
