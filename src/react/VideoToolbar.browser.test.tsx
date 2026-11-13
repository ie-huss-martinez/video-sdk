import "@hussmartinez/ui/styles.css";
import "../styles.css";
import { platformOf } from "@hussmartinez/sdk-core";
import axe from "axe-core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import { VideoEditor, type VideoEditorHandle, type VideoEditorProps } from "./VideoEditor.js";

// The editor's tools (docs/adr/0007, sdk-core ADR 0030): the toolbar, the
// shortcuts on the editor's root, focus after edits, and one Messages object
// for the SDK's text and ui's (sdk-core ADR 0046). The fixture is 60 frames
// at 30 per second.

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

const mod = platformOf(navigator) === "apple" ? "Meta" : "Control";

/** Waits for an assertion, with room for a loaded machine: the session and output run in workers. */
const eventually = <T,>(assertion: () => T | Promise<T>, timeout = 5_000) =>
  vi.waitFor(assertion, { timeout });

const fixture = async () => {
  const blob = await (await fetch(landscapeVp8)).blob();
  return new File([blob], "landscape.webm", { type: "video/webm" });
};

function render(props: VideoEditorProps, handle?: React.Ref<VideoEditorHandle>): HTMLElement {
  container = document.createElement("div");
  container.style.inlineSize = "640px";
  container.style.blockSize = "520px";
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(<VideoEditor ref={handle} {...props} />);
  });
  return container;
}

/** An editor with the fixture in it `count` times, ready to play. */
async function editorWith(count: number, props: VideoEditorProps = {}) {
  const handle = createRef<VideoEditorHandle>();
  const file = await fixture();
  const view = render({ ...props, initialFiles: Array(count).fill(file) }, handle);
  await eventually(() => expect(clipsIn(view)).toHaveLength(count), 15_000);
  await eventually(() =>
    expect(
      (view.querySelector('button[aria-label="Previous frame"]') as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  return { view, handle: handle.current as VideoEditorHandle };
}

const clipsIn = (view: HTMLElement) => [...view.querySelectorAll<HTMLElement>('[role="option"]')];
const names = (view: HTMLElement) => clipsIn(view).map((clip) => clip.getAttribute("aria-label"));
const tool = (view: HTMLElement, id: string) =>
  view.querySelector(`[data-hm-tool="${id}"]`) as HTMLButtonElement | null;
const announced = (view: HTMLElement) =>
  [...view.querySelectorAll(".hm-announcer [aria-live]")]
    .map((region) => region.textContent)
    .join(" ");

describe("the editor's tools", () => {
  it("shows the toolbar's groups, with each tool's keys, and no violations", async () => {
    const { view } = await editorWith(1);
    const toolbar = view.querySelector('[role="toolbar"]') as HTMLElement;
    expect(toolbar.getAttribute("aria-label")).toBe("Editing tools");
    expect(
      [...toolbar.querySelectorAll('[role="group"]')].map((g) => g.getAttribute("aria-label")),
    ).toEqual(["File", "History", "Edit", "View"]);
    const undo = tool(view, "video.undo") as HTMLButtonElement;
    expect(undo.getAttribute("aria-keyshortcuts")).toBe(mod === "Meta" ? "Meta+Z" : "Control+Z");
    expect(undo.title).toBe(mod === "Meta" ? "Undo (⌘Z)" : "Undo (Ctrl+Z)");
    // Nothing to redo: it stays in the toolbar's keyboard order, marked disabled.
    const redo = tool(view, "video.redo") as HTMLButtonElement;
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    expect(redo.disabled).toBe(false);
    expect(tool(view, "video.split")?.title).toBe("Split at the playhead (S)");
    expect(
      (view.querySelector('button[aria-label="Next frame"]') as HTMLElement).getAttribute(
        "aria-keyshortcuts",
      ),
    ).toBe("ArrowRight");
    const result = await axe.run(view);
    expect(result.violations.map((each) => `${each.id}: ${each.help}`)).toEqual([]);
  });

  it("splits, mutes and deletes from the keys, moving focus as the edits do, and undoes with an announcement", async () => {
    const { view, handle } = await editorWith(1);
    act(() => handle.seek(45));
    await eventually(() =>
      expect(tool(view, "video.split")?.getAttribute("aria-disabled")).toBeNull(),
    );
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("s");
    // Focus goes to the second part, at the playhead (docs/adr/0007).
    await eventually(() => expect(names(view)).toHaveLength(2));
    await eventually(() => expect(document.activeElement).toBe(clipsIn(view)[1]));
    expect(names(view)[1]).toBe("Clip 2 of 2, 0:01.50 to 0:02.00");
    await userEvent.keyboard("m");
    await eventually(() => expect(names(view)[1]).toBe("Clip 2 of 2, 0:01.50 to 0:02.00, muted"));
    expect(tool(view, "video.mute")?.getAttribute("aria-pressed")).toBe("true");
    await userEvent.keyboard("{Delete}");
    // The clip before takes focus when the last one goes.
    await eventually(() => expect(names(view)).toEqual(["Clip 1 of 1, 0:00.00 to 0:01.50"]));
    await eventually(() => expect(document.activeElement).toBe(clipsIn(view)[0]));
    await userEvent.keyboard(`{${mod}>}z{/${mod}}`);
    await eventually(() => expect(names(view)).toHaveLength(2));
    await eventually(() => expect(announced(view)).toContain("Undone"));
  });

  it("plays with Space in the editor, but Space on a button presses the button", async () => {
    const { view } = await editorWith(1);
    const zoomIn = tool(view, "video.zoom-in") as HTMLButtonElement;
    const track = view.querySelector(".hm-video-timeline-track") as HTMLElement;
    const fitted = track.getBoundingClientRect().width;
    zoomIn.focus();
    await userEvent.keyboard(" ");
    await eventually(() => expect(track.getBoundingClientRect().width).toBeGreaterThan(fitted));
    expect(view.querySelector('button[aria-label="Pause"]')).toBeNull();
    // Space on a clip is the listbox's own: it toggles the clip.
    clipsIn(view)[0]?.focus();
    expect(clipsIn(view)[0]?.getAttribute("aria-selected")).toBe("false");
    await userEvent.keyboard(" ");
    expect(clipsIn(view)[0]?.getAttribute("aria-selected")).toBe("true");
    expect(view.querySelector('button[aria-label="Pause"]')).toBeNull();
    // After a click on the preview, focus is on no control, and Space plays.
    await userEvent.click(view.querySelector(".hm-video-stage") as HTMLElement);
    await userEvent.keyboard(" ");
    await eventually(() => expect(view.querySelector('button[aria-label="Pause"]')).not.toBeNull());
    await userEvent.keyboard(" ");
    await eventually(() => expect(view.querySelector('button[aria-label="Play"]')).not.toBeNull());
  });

  it("zooms with +, - and 0, without a modifier", async () => {
    const { view } = await editorWith(2);
    const track = view.querySelector(".hm-video-timeline-track") as HTMLElement;
    const fitted = track.getBoundingClientRect().width;
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("+");
    await eventually(() =>
      expect(track.getBoundingClientRect().width).toBeCloseTo(fitted * 1.5, 0),
    );
    await userEvent.keyboard("-");
    await eventually(() => expect(track.getBoundingClientRect().width).toBeCloseTo(fitted, 0));
    await userEvent.keyboard("++0");
    await eventually(() => expect(track.getBoundingClientRect().width).toBeCloseTo(fitted, 0));
  });

  it("has only the tools a host chooses, with their keys and nothing else's", async () => {
    const { view, handle } = await editorWith(1, { tools: ["video.undo", "video.redo"] });
    expect(
      [...view.querySelectorAll("[data-hm-tool]")].map((each) => each.getAttribute("data-hm-tool")),
    ).toEqual(["video.undo", "video.redo"]);
    act(() => handle.seek(30));
    clipsIn(view)[0]?.focus();
    await userEvent.keyboard("s");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(names(view)).toHaveLength(1);
  });

  it("takes a host's overrides of ui's text through its own messages prop (sdk-core ADR 0046)", async () => {
    const view = render({
      messages: { "fileDropZone.chooseMultiple": "Pick videos", "editor.label": "Montage" },
    });
    await eventually(() => expect(view.textContent).toContain("Pick videos"));
    expect(view.querySelector("section")?.getAttribute("aria-label")).toBe("Montage");
  });
});
