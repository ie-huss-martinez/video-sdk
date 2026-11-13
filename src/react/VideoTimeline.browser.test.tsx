import "@hussmartinez/ui/styles.css";
import "../styles.css";
import { platformOf } from "@hussmartinez/sdk-core";
import axe from "axe-core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import { VideoEditor, type VideoEditorHandle } from "./VideoEditor.js";

// The timeline (docs/adr/0007): its listbox, keyboard edits, pointer trims,
// the playhead slider and zoom, over the SDK's real session and output. The
// fixture is 60 frames at 30 per second, so two of it are 0:04.00.

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

/** Waits for an assertion, with room for a loaded machine: the session and output run in workers. */
const eventually = <T,>(assertion: () => T | Promise<T>, timeout = 5_000) =>
  vi.waitFor(assertion, { timeout });

const mod = platformOf(navigator) === "apple" ? "Meta" : "Control";

const fixture = async () => {
  const blob = await (await fetch(landscapeVp8)).blob();
  return new File([blob], "landscape.webm", { type: "video/webm" });
};

/** An editor with the fixture in it `count` times, once its clips are there. */
async function editorWith(count: number) {
  const file = await fixture();
  const handle = createRef<VideoEditorHandle>();
  container = document.createElement("div");
  container.style.inlineSize = "640px";
  container.style.blockSize = "480px";
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(<VideoEditor ref={handle} initialFiles={Array(count).fill(file)} />);
  });
  const view = container;
  await eventually(() => expect(clipsIn(view)).toHaveLength(count), 15_000);
  // The output has the plan once the play button is on.
  await eventually(() =>
    expect((view.querySelector('button[aria-label="Play"]') as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  return { view, handle: handle.current as VideoEditorHandle, file };
}

const clipsIn = (view: HTMLElement) =>
  [...view.querySelectorAll<HTMLElement>('[role="option"]')] as HTMLElement[];
const names = (view: HTMLElement) => clipsIn(view).map((clip) => clip.getAttribute("aria-label"));
const selected = (view: HTMLElement) =>
  clipsIn(view).map((clip) => clip.getAttribute("aria-selected") === "true");
const keysOf = (view: HTMLElement) => clipsIn(view).map((clip) => clip.dataset["hmKey"]);
const button = (view: HTMLElement, label: string) =>
  view.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

describe("the timeline", () => {
  it("lists the clips with their ranges, one tab stop, no violations, and doesn't take focus on load", async () => {
    const { view } = await editorWith(2);
    const listbox = view.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.getAttribute("aria-label")).toBe("Clips");
    expect(listbox.getAttribute("aria-orientation")).toBe("horizontal");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(names(view)).toEqual([
      "Clip 1 of 2, 0:00.00 to 0:02.00",
      "Clip 2 of 2, 0:02.00 to 0:04.00",
    ]);
    expect(clipsIn(view).map((clip) => clip.tabIndex)).toEqual([0, -1]);
    expect(document.activeElement?.getAttribute("role")).not.toBe("option");
    const slider = view.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.getAttribute("aria-label")).toBe("Playhead");
    expect(slider.getAttribute("aria-valuetext")).toBe("0:00.00");
    expect(slider.max).toBe("119");
    const result = await axe.run(view);
    expect(result.violations.map((each) => `${each.id}: ${each.help}`)).toEqual([]);
  });

  it("moves focus and selection with the arrows, Home and End; Shift extends, Mod only moves focus", async () => {
    const { view } = await editorWith(3);
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(clipsIn(view)[1]);
    expect(selected(view)).toEqual([false, true, false]);
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(selected(view)).toEqual([false, true, true]);
    await userEvent.keyboard(`{${mod}>}{Home}{/${mod}}`);
    expect(document.activeElement).toBe(clipsIn(view)[0]);
    expect(selected(view)).toEqual([false, true, true]);
    await userEvent.keyboard(`{${mod}>} {/${mod}}`);
    expect(selected(view)).toEqual([true, true, true]);
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(clipsIn(view)[2]);
    expect(selected(view)).toEqual([false, false, true]);
    expect(clipsIn(view).map((clip) => clip.tabIndex)).toEqual([-1, -1, 0]);
    // A click selects, and Shift-click extends from the last one.
    await userEvent.click(clipsIn(view)[0] as HTMLElement, { position: { x: 30, y: 10 } });
    expect(selected(view)).toEqual([true, false, false]);
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(clipsIn(view)[1] as HTMLElement, { position: { x: 30, y: 10 } });
    await userEvent.keyboard("{/Shift}");
    expect(selected(view)).toEqual([true, true, false]);
  });

  it("marks the arrows it handles, so the editor's shortcuts skip them", async () => {
    const { view } = await editorWith(2);
    const seen: boolean[] = [];
    view.addEventListener("keydown", (event) => seen.push(event.defaultPrevented));
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(seen).toEqual([true, true]);
  });

  it("moves the selected clip past its neighbour with Alt and the arrows, keeping focus on it", async () => {
    const { view, handle } = await editorWith(3);
    const [a, b, c] = keysOf(view);
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await eventually(() => expect(keysOf(view)).toEqual([b, a, c]));
    await eventually(() =>
      expect((document.activeElement as HTMLElement).dataset["hmKey"]).toBe(a),
    );
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await eventually(() => expect(keysOf(view)).toEqual([b, c, a]));
    // Already last: nothing happens.
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(keysOf(view)).toEqual([b, c, a]);
    act(() => {
      handle.undo();
      handle.undo();
    });
    expect(keysOf(view)).toEqual([a, b, c]);
  });

  it("trims to the playhead with the brackets and the trim buttons, and a frame at a time with Alt", async () => {
    const { view, handle } = await editorWith(2);
    act(() => handle.seek(30));
    const trimEnd = button(view, "Trim the clip's end to the playhead");
    await eventually(() => expect(trimEnd.disabled).toBe(false));
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("]");
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.00"));
    // Alt+Shift+] lengthens the end a frame; Alt+[ shortens the start one.
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("{Alt>}{Shift>}]{/Shift}{/Alt}");
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.03"));
    await userEvent.keyboard("{Alt>}[[{/Alt}");
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.00"));
    // The start can't go before the source's: the clip now starts a frame in, so one frame back works, then no more.
    await userEvent.keyboard("{Alt>}{Shift>}[[{/Shift}{/Alt}");
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.03"));
    await userEvent.keyboard("{Alt>}{Shift>}[[{/Shift}{/Alt}");
    expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.03");
    // The buttons do the same, for a pointer: the playhead in clip 2, its start to it.
    act(() => handle.seek(61));
    await userEvent.click(clipsIn(view)[1] as HTMLElement, { position: { x: 30, y: 10 } });
    const trimStart = button(view, "Trim the clip's start to the playhead");
    await eventually(() => expect(trimStart.disabled).toBe(false));
    await userEvent.click(trimStart);
    await eventually(() => expect(names(view)[1]).toBe("Clip 2 of 2, 0:01.03 to 0:02.03"));
  });

  it("trims by dragging an edge, snapping to the playhead unless Alt is held", async () => {
    const { view, handle } = await editorWith(2);
    act(() => handle.seek(45));
    const slider = view.querySelector('input[type="range"]') as HTMLInputElement;
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("0:01.50"));
    const first = clipsIn(view)[0] as HTMLElement;
    const edge = first.querySelector('[data-hm-edge="end"]') as HTMLElement;
    const box = edge.getBoundingClientRect();
    const track = view.querySelector(".hm-video-timeline-track") as HTMLElement;
    const perFrame = track.getBoundingClientRect().width / 120;
    const drag = (toFrame: number, altKey: boolean) => {
      const from = box.right - 1;
      const to = track.getBoundingClientRect().left + toFrame * perFrame;
      const init = { bubbles: true, pointerId: 1, button: 0, clientY: box.top + 2, altKey };
      edge.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from }));
      edge.dispatchEvent(new PointerEvent("pointermove", { ...init, clientX: to }));
      edge.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to }));
    };
    // Two frames from the playhead snaps to it: 8 px is 2 frames at about 5 px a frame.
    act(() => drag(43, false));
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.50"));
    act(() => handle.undo());
    act(() => drag(43, true));
    await eventually(() => expect(names(view)[0]).toBe("Clip 1 of 2, 0:00.00 to 0:01.43"));
  });

  it("zooms in and out, and fits the whole video", async () => {
    const { view } = await editorWith(2);
    const track = view.querySelector(".hm-video-timeline-track") as HTMLElement;
    const fitted = track.getBoundingClientRect().width;
    // Zoom is the editor's tools now, kept focusable while they can't run.
    expect(button(view, "Zoom out").getAttribute("aria-disabled")).toBe("true");
    expect(button(view, "Fit the whole video").getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(button(view, "Zoom in"));
    expect(track.getBoundingClientRect().width).toBeCloseTo(fitted * 1.5, 0);
    expect(button(view, "Zoom out").getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(button(view, "Fit the whole video"));
    expect(track.getBoundingClientRect().width).toBeCloseTo(fitted, 0);
  });

  it("moves focus to a new clip when the editor has focus", async () => {
    const { view, handle, file } = await editorWith(1);
    clipsIn(view)[0]?.focus();
    await act(async () => {
      await handle.insert(file);
    });
    await eventually(() => expect(document.activeElement).toBe(clipsIn(view)[1]));
    expect(selected(view)).toEqual([false, true]);
  });

  it("seeks with the playhead slider, reading the time", async () => {
    const { view } = await editorWith(1);
    const slider = view.querySelector('input[type="range"]') as HTMLInputElement;
    slider.focus();
    await userEvent.keyboard("{PageUp}");
    await eventually(() => expect(slider.getAttribute("aria-valuetext")).toBe("0:01.00"));
    expect(view.querySelector(".hm-video-transport-time")?.textContent).toBe("0:01.00 of 0:02.00");
  });
});
