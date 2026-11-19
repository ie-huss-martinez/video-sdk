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

/** One of the inspector's groups, by its legend. */
const group = (view: HTMLElement, legend: string) =>
  [...view.querySelectorAll<HTMLElement>("fieldset")].find(
    (element) => element.querySelector("legend")?.textContent === legend,
  ) as HTMLElement;
const iconButton = (view: HTMLElement, label: string) =>
  view.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const transforms = () => planClips().map((clip) => clip.transform);

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
      expect(inspector(view)?.textContent).toContain(
        "Select a clip to change its sound and picture.",
      ),
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

  it("sets the volume once for each key let go, and once for a key held down", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const slider = byLabel(view, "Volume");
    slider.focus();
    // A press and its release: one gesture, one step (ui's Slider, 0.13).
    await userEvent.keyboard("{ArrowLeft}");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(-1));
    // Held, it repeats: shown as it moves, in the plan when it's let go.
    await userEvent.keyboard("{ArrowLeft>3}");
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("-4 dB"));
    expect(planClips()[0]?.volumeDb).toBe(-1);
    await userEvent.keyboard("{/ArrowLeft}");
    await eventually(() => expect(planClips()[0]?.volumeDb).toBe(-4));
    expect(byLabel(view, "Volume in decibels").value).toBe("-4");
    // Two gestures, two steps.
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips()[0]?.volumeDb).toBe(-1);
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("-1 dB"));
    act(() => {
      (session as VideoSession).undo();
    });
    expect(planClips()[0]?.volumeDb).toBe(0);
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(planClips()[0]?.volumeDb).toBe(0);
    expect(slider.getAttribute("aria-valuetext")).toBe("-9 dB");
    act(() => {
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(planClips()[0]?.volumeDb).toBe(-9);
    // A key held down, then focus leaves before it's let go: committed then.
    slider.focus();
    await userEvent.keyboard("{ArrowRight>1}");
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("-8 dB"));
    act(() => slider.blur());
    await userEvent.keyboard("{/ArrowRight}");
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

  it("cancels a volume gesture with Escape: nothing committed, and the preview back to the plan", async () => {
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
    await act(async () => {
      await playing.play();
    });
    await eventually(() => expect(playing.getSnapshot().state).toBe("playing"));
    const slider = byLabel(view, "Volume");
    slider.focus();
    const before = (session as VideoSession).getSnapshot().plan;
    loads.length = 0;
    // Held, it's heard as it moves: the preview plays the slider's value.
    await userEvent.keyboard("{ArrowLeft>3}");
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(-3));
    // Escape cancels it (ui 0.15): the value goes back, and nothing is committed.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{/ArrowLeft}");
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("0 dB"));
    // No command ran: the session's plan is the very one before the gesture.
    expect((session as VideoSession).getSnapshot().plan).toBe(before);
    // The preview ended with the gesture: what plays is the session's plan again.
    await eventually(() => expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(loads.at(-1)?.clips[0]?.volumeDb).toBe(0);
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
    // The two fades' shapes, then the picture's fit.
    expect(shapes).toHaveLength(3);
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
    const sound = group(view, "Sound of the selected clip");
    expect(sound.textContent).toContain("This clip has no sound.");
    expect(sound.querySelectorAll("input, button")).toHaveLength(0);
    // Its picture can still be changed.
    expect(iconButton(view, "Rotate right").disabled).toBe(false);
  });

  it("turns the selected clip a quarter turn either way, and says its rotation", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const picture = group(view, "Picture of the selected clip");
    const rotation = picture.querySelector("output") as HTMLOutputElement;
    expect(rotation.textContent).toBe("0°");
    await userEvent.click(iconButton(view, "Rotate right"));
    await eventually(() => expect(transforms()[0]?.rotation).toBe(90));
    expect(rotation.textContent).toBe("90°");
    await userEvent.click(iconButton(view, "Rotate left"));
    await userEvent.click(iconButton(view, "Rotate left"));
    await eventually(() => expect(transforms()[0]?.rotation).toBe(270));
    expect(rotation.textContent).toBe("270°");
    const result = await axe.run(picture);
    expect(result.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });

  it("sets how the picture fills the frame", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const fit =
      view.querySelector('[role="radiogroup"][aria-label="Fit in the frame"]') ??
      [...view.querySelectorAll<HTMLElement>('[role="radiogroup"]')].at(-1);
    const fill = [...(fit as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')].find(
      (radio) => radio.textContent === "Fill",
    ) as HTMLElement;
    await userEvent.click(fill);
    await eventually(() => expect(transforms()[0]?.fit).toBe("cover"));
    expect(fill.getAttribute("aria-checked")).toBe("true");
  });

  it("crops one clip in pixels of its picture, keeps the crop inside it, and removes it", async () => {
    const view = await inspectorWith(1);
    await select(view, 1);
    const source = (session as VideoSession).getSnapshot().sources[0]?.video as {
      width: number;
      height: number;
    };
    const { width, height } = source;
    // With no crop, the fields show the whole picture, and there's none to remove.
    expect(byLabel(view, "Crop width, in pixels").value).toBe(String(width));
    expect(byLabel(view, "Crop height, in pixels").value).toBe(String(height));
    expect(button(view, "Remove the crop").disabled).toBe(true);

    await enter(byLabel(view, "Crop from the left, in pixels"), "10");
    await eventually(() =>
      expect(transforms()[0]?.crop).toEqual({ x: 10, y: 0, width: width - 10, height }),
    );
    // Wider than what's left of the picture: kept inside it.
    await enter(byLabel(view, "Crop width, in pixels"), "99999");
    await eventually(() =>
      expect(byLabel(view, "Crop width, in pixels").value).toBe(String(width - 10)),
    );
    await enter(byLabel(view, "Crop height, in pixels"), "1");
    await eventually(() => expect(transforms()[0]?.crop?.height).toBe(2));
    expect((session as VideoSession).getSnapshot().error).toBeNull();

    // A turn takes the crop with it: its size swaps, and the reducer accepts it.
    await userEvent.click(iconButton(view, "Rotate right"));
    await eventually(() => expect(transforms()[0]?.rotation).toBe(90));
    expect(transforms()[0]?.crop).toMatchObject({ width: 2, height: width - 10 });
    expect((session as VideoSession).getSnapshot().error).toBeNull();

    await userEvent.click(button(view, "Remove the crop"));
    await eventually(() => expect(transforms()[0]?.crop).toBeNull());
    expect(button(view, "Remove the crop").disabled).toBe(true);
  });

  it("turns every selected clip as one undo step, and crops only one clip at a time", async () => {
    const view = await inspectorWith(2);
    await select(view, 1);
    await userEvent.click(iconButton(view, "Rotate right"));
    await eventually(() => expect(transforms()[0]?.rotation).toBe(90));
    await select(view, 1, 2);
    const picture = group(view, "Picture of the 2 selected clips");
    expect(picture.querySelector("output")?.textContent).toBe("Different for each clip");
    expect(picture.textContent).toContain("Select one clip to crop it.");
    expect(picture.querySelectorAll('[role="spinbutton"]')).toHaveLength(0);
    // Each turns from where it is.
    await userEvent.click(iconButton(view, "Rotate right"));
    await eventually(() => expect(transforms().map((t) => t.rotation)).toEqual([180, 90]));
    act(() => {
      (session as VideoSession).undo();
    });
    expect(transforms().map((t) => t.rotation)).toEqual([90, 0]);
  });

  describe("with no clip selected", () => {
    /** An editor with one clip, and nothing selected. */
    async function nothingSelected() {
      const view = await inspectorWith(1);
      const clip = clipsIn(view)[0] as HTMLElement;
      if (clip.getAttribute("aria-selected") === "true") {
        await userEvent.keyboard("{Control>}");
        await userEvent.click(clip);
        await userEvent.keyboard("{/Control}");
      }
      await eventually(() => expect(group(view, "The exported video")).toBeDefined());
      return view;
    }
    const output = () => (session as VideoSession).getSnapshot().plan?.output;
    const metadata = () => (session as VideoSession).getSnapshot().plan?.metadata;
    const radio = (view: HTMLElement, groupName: string, label: string) => {
      const radios = [
        ...(
          view.querySelector(`[role="radiogroup"][aria-label="${groupName}"]`) ?? view
        ).querySelectorAll<HTMLElement>('[role="radio"]'),
      ];
      return radios.find((element) => element.textContent === label) as HTMLElement;
    };

    it("shows the output and the metadata, with no accessibility violations", async () => {
      const view = await nothingSelected();
      const { width, height } = output() as { width: number; height: number };
      expect(byLabel(view, "Width, in pixels").value).toBe(String(width));
      expect(byLabel(view, "Height, in pixels").value).toBe(String(height));
      expect(byLabel(view, "Frames per second").value).toBe("30");
      expect(group(view, "Details in the file").textContent).toContain(
        "Nothing is copied from your original files.",
      );
      const result = await axe.run(inspector(view) as HTMLElement);
      expect(result.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual(
        [],
      );
    });

    it("sets the size in even pixels, and refuses one over the limit, saying why", async () => {
      const view = await nothingSelected();
      const before = output();
      await enter(byLabel(view, "Width, in pixels"), "641");
      await eventually(() => expect(output()?.width).toBe(640));
      await enter(byLabel(view, "Width, in pixels"), "100000");
      await eventually(() =>
        expect(group(view, "The exported video").textContent).toContain("Choose a smaller size."),
      );
      expect(output()?.width).toBe(640);
      expect((session as VideoSession).getSnapshot().error).toBeNull();
      act(() => {
        (session as VideoSession).undo();
      });
      expect(output()).toEqual(before);
    });

    it("snaps the frame rate to an exact one, and sets the sound's quality and channels", async () => {
      const view = await nothingSelected();
      await enter(byLabel(view, "Frames per second"), "29.97");
      await eventually(() => expect(output()?.frameRate).toEqual({ num: 30_000, den: 1_001 }));
      expect(byLabel(view, "Frames per second").value).toBe("29.97");
      await userEvent.click(radio(view, "Sound quality", "44.1 kHz"));
      await eventually(() => expect(output()?.sampleRate).toBe(44_100));
      await userEvent.click(radio(view, "Sound channels", "Mono"));
      await eventually(() => expect(output()?.channels).toBe(1));
      // Every clip stays on the new grid: the session took the commands.
      expect((session as VideoSession).getSnapshot().error).toBeNull();
    });

    it("sets a metadata field when it's committed, as one step, and refuses a date that isn't one", async () => {
      const view = await nothingSelected();
      const title = byLabel(view, "Title");
      await userEvent.click(title);
      await userEvent.keyboard("Take 1");
      // Typing changes nothing yet.
      expect(metadata()?.title).toBe("");
      await userEvent.keyboard("{Enter}");
      await eventually(() => expect(metadata()?.title).toBe("Take 1"));
      const date = byLabel(view, "Date");
      await userEvent.click(date);
      await userEvent.keyboard("next week");
      act(() => date.blur());
      await eventually(() =>
        expect(group(view, "Details in the file").textContent).toContain(
          "Enter a date as year-month-day",
        ),
      );
      expect(metadata()?.date).toBe("");
      await userEvent.clear(date);
      await userEvent.keyboard("2026-11-18{Tab}");
      await eventually(() => expect(metadata()?.date).toBe("2026-11-18"));
      // A long field commits when focus leaves.
      await userEvent.click(byLabel(view, "Description"));
      await userEvent.keyboard("Line one{Enter}Line two");
      act(() => (byLabel(view, "Description") as HTMLElement).blur());
      await eventually(() => expect(metadata()?.description).toBe("Line one\nLine two"));
      // Undo puts the field back as it was.
      act(() => {
        (session as VideoSession).undo();
      });
      await eventually(() => expect(byLabel(view, "Description").value).toBe(""));
    });
  });
});
