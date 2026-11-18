import "@hussmartinez/ui/styles.css";
import "../styles.css";
import { AnnouncerProvider, UiMessagesProvider } from "@hussmartinez/ui/react";
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import landscape from "../../test/fixtures/video/landscape.webm?url";
import silent from "../../test/fixtures/video/silent-vp8.webm?url";
import type { VideoPlan } from "../core/model/plan.js";
import type { VideoOutput } from "../core/ports/video-output.js";
import type { VideoSession } from "../core/session/session.js";
import { useVideoEditor, VideoEditorProvider } from "./context.js";
import { KEY_RUN } from "./gesture.js";
import { VideoInspector } from "./VideoInspector.js";
import { VideoStage } from "./VideoStage.js";
import { VideoTimeline } from "./VideoTimeline.js";

// Real probing and opening run in workers, and a heavily loaded machine
// slows them several times over: a minute per test, so that load fails a
// test only through its own checks.
vi.setConfig({ testTimeout: 60_000 });

// The inspector's clip panel (docs/adr/0008): volume, mute and fades of the
// selected clips, as a building block beside the timeline, over the SDK's
// real session. `landscape.webm` has Opus audio; `silent-vp8.webm` has none.

let root: Root | undefined;
let container: HTMLElement | undefined;
let session: VideoSession | undefined;
let output: VideoOutput | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  act(() => root?.unmount());
  root = undefined;
  session = undefined;
  output = null;
  container?.remove();
  container = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const eventually = <T,>(assertion: () => T | Promise<T>, timeout = 15_000) =>
  vi.waitFor(assertion, { timeout });

/** The building blocks in a layout of a host's own, with the editor's text for ui's parts. */
function Blocks() {
  const editor = useVideoEditor();
  session = editor.session;
  output = editor.output;
  return (
    <UiMessagesProvider messages={editor.messages}>
      <AnnouncerProvider>
        <div className="test-stage">
          <VideoStage />
        </div>
        <VideoTimeline />
        <VideoInspector />
      </AnnouncerProvider>
    </UiMessagesProvider>
  );
}

function render(): HTMLElement {
  container = document.createElement("div");
  container.className = "hm-text";
  container.style.inlineSize = "640px";
  const style = document.createElement("style");
  style.textContent = ".test-stage { block-size: 120px; display: grid; }";
  container.append(style);
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(
      <VideoEditorProvider>
        <Blocks />
      </VideoEditorProvider>,
    );
  });
  return container;
}

const fileOf = async (url: string) =>
  new File([await (await fetch(url)).blob()], "clip.webm", { type: "video/webm" });

/** The building blocks with a fixture in the plan `count` times. */
async function inspectorWith(count: number, url: string = landscape) {
  const view = render();
  const file = await fileOf(url);
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await (session as VideoSession).insert(file);
    });
  }
  await eventually(() => expect(clipsIn(view)).toHaveLength(count));
  return view;
}

const clipsIn = (view: HTMLElement) => [...view.querySelectorAll<HTMLElement>('[role="option"]')];
const planClips = () => (session as VideoSession).getSnapshot().plan?.clips ?? [];
const inspector = (view: HTMLElement) =>
  view.querySelector('section[aria-label="Inspector"]') as HTMLElement | null;
const byLabel = (view: HTMLElement, label: string) => {
  const found = [...view.querySelectorAll<HTMLLabelElement>("label")].find(
    (element) => element.textContent === label,
  );
  return view.querySelector(`#${CSS.escape(found?.htmlFor ?? "missing")}`) as HTMLInputElement;
};
const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll<HTMLButtonElement>("button, [role=radio]")].find(
    (element) => element.textContent === name,
  ) as HTMLButtonElement;

/** Selects clips by their place, from 1: a click, then Mod-clicks. */
async function select(view: HTMLElement, ...places: number[]) {
  for (const [index, place] of places.entries()) {
    const clip = clipsIn(view)[place - 1] as HTMLElement;
    if (index === 0) await userEvent.click(clip);
    else {
      await userEvent.keyboard("{Control>}");
      await userEvent.click(clip);
      await userEvent.keyboard("{/Control}");
    }
  }
  await eventually(() =>
    expect(
      clipsIn(view).filter((clip) => clip.getAttribute("aria-selected") === "true"),
    ).toHaveLength(places.length),
  );
}

/** Types into a number field and commits it with Enter. */
async function enter(field: HTMLInputElement, text: string) {
  await userEvent.clear(field);
  await userEvent.type(field, `${text}{Enter}`);
}

/** Sets a range input as the browser does while its thumb moves: an input event, no change. */
function slide(input: HTMLInputElement, value: number) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the inspector's clip panel", () => {
  it("renders nothing before a video is open, and says what to select once one is", async () => {
    const view = render();
    expect(inspector(view)).toBeNull();
    const file = await fileOf(landscape);
    await act(async () => {
      await (session as VideoSession).insert(file);
    });
    // An insert selects the new clip; with nothing selected, it says what to select.
    await eventually(() => expect(inspector(view)).not.toBeNull());
    act(() => (session as VideoSession).select(null));
    const clip = clipsIn(view)[0] as HTMLElement;
    if (clip.getAttribute("aria-selected") === "true") {
      await userEvent.keyboard("{Control>}");
      await userEvent.click(clip);
      await userEvent.keyboard("{/Control}");
    }
    await eventually(() =>
      expect(inspector(view)?.textContent).toBe("Select a clip to change its sound."),
    );
  });

  it("shows the selected clip's sound, with no accessibility violations", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const panel = inspector(view) as HTMLElement;
    expect(panel.querySelector("legend")?.textContent).toBe("Sound of the selected clip");
    expect(byLabel(view, "Volume").getAttribute("aria-valuetext")).toBe("0 dB");
    expect(byLabel(view, "Volume in decibels").value).toBe("0");
    expect(button(view, "Mute").getAttribute("aria-pressed")).toBe("false");
    expect(byLabel(view, "Fade in, in seconds").value).toBe("0");
    expect(byLabel(view, "Fade out, in seconds").value).toBe("0");
    const result = await axe.run(panel);
    expect(result.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it("sets the volume from a run of the slider's keys, as one undo step", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const slider = byLabel(view, "Volume");
    slider.focus();
    // A real key moves the slider, as the browser's own range input does.
    await userEvent.keyboard("{ArrowLeft}");
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("-1 dB"));
    // Then the rest of the run, as a held key repeats: each step's input
    // event within one task, so a slow machine can't put KEY_RUN between
    // them. Each key the test runner sends is a round trip to the browser,
    // which a loaded machine can stretch past KEY_RUN.
    slide(slider, -2);
    slide(slider, -3);
    // Shown at once; in the plan when the run of keys ends.
    expect(slider.getAttribute("aria-valuetext")).toBe("-3 dB");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(-3), KEY_RUN + 5_000);
    expect(byLabel(view, "Volume in decibels").value).toBe("-3");
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips()[0]?.volumeDb).toBe(0);
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("0 dB"));
  });

  it("sets the volume once when a drag of the slider ends, and when focus leaves mid-run", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const slider = byLabel(view, "Volume");
    act(() => {
      slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    slide(slider, -4);
    slide(slider, -9);
    // Nothing is in the plan while the thumb is held, however long.
    await new Promise((resolve) => setTimeout(resolve, KEY_RUN + 100));
    expect(planClips()[0]?.volumeDb).toBe(0);
    expect(slider.getAttribute("aria-valuetext")).toBe("-9 dB");
    act(() => {
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(planClips()[0]?.volumeDb).toBe(-9);
    // Keys, then focus leaves before the run's pause: committed at once.
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    act(() => slider.blur());
    expect(planClips()[0]?.volumeDb).toBe(-8);
    act(() => {
      (session as VideoSession).undo();
      (session as VideoSession).undo();
    });
    expect(planClips()[0]?.volumeDb).toBe(0);
    expect((session as VideoSession).getSnapshot().canUndo).toBe(true);
  });

  it("plays a drag of the volume to the preview as it moves while the video plays, and commits one step", async () => {
    // Four clips, so playback outlasts the test.
    const view = await inspectorWith(4);
    await select(view, 1);
    const playing = await eventually(() => {
      expect(output).not.toBeNull();
      return output as VideoOutput;
    });
    const loads: VideoPlan[] = [];
    const load = playing.load.bind(playing);
    playing.load = (plan) => {
      loads.push(plan);
      load(plan);
    };
    const slider = byLabel(view, "Volume");
    const press = () =>
      act(() => {
        slider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      });
    const release = () =>
      act(() => {
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });

    // Paused, there's nothing to hear: a drag loads no plan until it ends.
    press();
    slide(slider, -4);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(loads).toEqual([]);
    release();
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(-4));

    // Every playback failure, even one a later load clears from the snapshot.
    const failures: string[] = [];
    const unsubscribe = playing.subscribe(() => {
      const error = playing.getSnapshot().error;
      if (error) failures.push(`${error.code} ${JSON.stringify(error.details)}`);
    });
    // Playing, each move is played, and the session's plan waits for the end.
    await act(async () => {
      await playing.play();
    });
    await eventually(() => expect(playing.getSnapshot().state).toBe("playing"));
    loads.length = 0;
    press();
    slide(slider, -9);
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(-9));
    expect(planClips()[0]?.volumeDb).toBe(-4);
    slide(slider, -20);
    slide(slider, -12);
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(-12));
    // Only the selected clip, and nothing but its volume.
    expect(loads.at(-1)?.clips.map((clip) => clip.volumeDb)).toEqual([-12, 0, 0, 0]);
    expect(planClips()[0]?.volumeDb).toBe(-4);
    // The previews didn't stop playback: no failure, and still playing.
    unsubscribe();
    expect(failures).toEqual([]);
    expect(playing.getSnapshot().state).toBe("playing");
    release();
    expect(planClips()[0]?.volumeDb).toBe(-12);
    // The drag was one step: one undo is back at the drag before it.
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips()[0]?.volumeDb).toBe(-4);
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(-4));
    act(() => playing.pause());
  });

  it("takes an exact volume from the number field, within the model's range", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    await enter(byLabel(view, "Volume in decibels"), "-72.5");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(-72.5));
    // Below the slider's range, the slider rests at its end.
    expect(byLabel(view, "Volume").value).toBe("-60");
    await enter(byLabel(view, "Volume in decibels"), "500");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(24));
  });

  it("mutes and unmutes, and the timeline names the clip muted", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    await userEvent.click(button(view, "Mute"));
    await eventually(() => expect(planClips()[0]?.muted).toBe(true));
    expect(button(view, "Mute").getAttribute("aria-pressed")).toBe("true");
    expect(clipsIn(view)[0]?.getAttribute("aria-label")).toMatch(/, muted$/);
    await userEvent.click(button(view, "Mute"));
    await eventually(() => expect(planClips()[0]?.muted).toBe(false));
  });

  it("sets each fade's length and shape, and keeps both within the clip", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const length = (planClips()[0]?.end ?? 0) - (planClips()[0]?.start ?? 0);
    await enter(byLabel(view, "Fade in, in seconds"), "0.5");
    await eventually(() =>
      expect(planClips()[0]?.fadeIn).toEqual({ duration: 500_000, curve: "linear" }),
    );
    const shapes = [...view.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
    expect(shapes.map((group) => group.getAttribute("aria-labelledby"))).toHaveLength(2);
    await userEvent.click(
      [...(shapes[0] as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')].find(
        (radio) => radio.textContent === "Smooth",
      ) as HTMLElement,
    );
    await eventually(() =>
      expect(planClips()[0]?.fadeIn).toEqual({ duration: 500_000, curve: "equalPower" }),
    );
    // More than the clip has left beside its fade in.
    await enter(byLabel(view, "Fade out, in seconds"), "999");
    await eventually(() => expect(planClips()[0]?.fadeOut.duration).toBe(length - 500_000));
    expect((session as VideoSession).getSnapshot().error).toBeNull();
  });

  it("applies a change to every selected clip as one undo step, and says when they differ", async () => {
    const view = await inspectorWith(2);
    await select(view, 1);
    await enter(byLabel(view, "Volume in decibels"), "-6");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(-6));
    await select(view, 1, 2);
    const panel = inspector(view) as HTMLElement;
    expect(panel.querySelector("legend")?.textContent).toBe("Sound of the 2 selected clips");
    expect(panel.textContent).toContain("The selected clips have different settings.");
    await enter(byLabel(view, "Fade in, in seconds"), "0.2");
    await eventually(() =>
      expect(planClips().map((clip) => clip.fadeIn.duration)).toEqual([200_000, 200_000]),
    );
    await enter(byLabel(view, "Volume in decibels"), "-10");
    await eventually(() => expect(planClips().map((clip) => clip.volumeDb)).toEqual([-10, -10]));
    expect(panel.textContent).not.toContain("different settings");
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips().map((clip) => clip.volumeDb)).toEqual([-6, 0]);
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips().map((clip) => clip.fadeIn.duration)).toEqual([0, 0]);
  });

  it("says so, with no controls, when the selected clip has no sound", async () => {
    const view = await inspectorWith(1, silent);
    await select(view, 1);
    const panel = inspector(view) as HTMLElement;
    expect(panel.textContent).toContain("This clip has no sound.");
    expect(panel.querySelectorAll("input, button")).toHaveLength(0);
  });
});
