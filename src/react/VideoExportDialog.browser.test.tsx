import "@hussmartinez/ui/styles.css";
import "../styles.css";
import axe from "axe-core";
import { act, createRef, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import { createVideoEngine } from "../adapters/video-engine.js";
import { useVideoSession, VideoEditorProvider } from "./context.js";
import { VideoEditor, type VideoEditorHandle } from "./VideoEditor.js";
import { VideoExportDialog, type VideoExportResult } from "./VideoExportDialog.js";
import { VideoToolbar } from "./VideoToolbar.js";

// Real decoding, playback and export run in workers, and a heavily loaded
// machine slows them several times over: minutes per test, so that load
// fails a test only through its own checks. Waits inside get their own
// timeouts, so no step runs on a nearly spent budget.
vi.setConfig({ testTimeout: 120_000 });

// The export dialog (docs/adr/0007): its summary before anything is written,
// a real export, stopping, and closing at any point, over the SDK's own
// engine and processor. The fixture is 2 s of 30 fps video.

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

/** Waits for an assertion, with room for a loaded machine: exports run in a worker. */
const eventually = <T,>(assertion: () => T | Promise<T>, timeout = 20_000) =>
  vi.waitFor(assertion, { timeout });

const fixture = async () => {
  const blob = await (await fetch(landscapeVp8)).blob();
  return new File([blob], "landscape.webm", { type: "video/webm" });
};

function mount(element: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  container.style.inlineSize = "640px";
  container.style.blockSize = "520px";
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(element);
  });
  return container;
}

/** The editor with the fixture in it, once its export tool can run. */
async function editor() {
  const handle = createRef<VideoEditorHandle>();
  const view = mount(<VideoEditor ref={handle} initialFiles={[await fixture()]} />);
  await eventually(() => expect(exportTool(view).getAttribute("aria-disabled")).toBeNull());
  return { view, handle: handle.current as VideoEditorHandle };
}

const exportTool = (view: HTMLElement) =>
  view.querySelector('[data-hm-tool="video.export"]') as HTMLButtonElement;
const dialogOf = (view: HTMLElement) => view.querySelector("dialog") as HTMLDialogElement;
const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("dialog button")].find((each) => each.textContent === name) as
    | HTMLButtonElement
    | undefined;
const announced = (view: HTMLElement) =>
  [...view.querySelectorAll(".hm-announcer [aria-live]")].map((each) => each.textContent).join(" ");

/** Waits for the dialog's fade-in, so axe checks contrast on its final colours. */
async function settled(dialog: HTMLDialogElement): Promise<void> {
  await Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished));
}

/** Inserts a file on mount: a host's own layout, with the dialog and a handler for the file. */
function Insert({ file }: { readonly file: File }) {
  const { session } = useVideoSession();
  useEffect(() => {
    void session.insert(file);
  }, [session, file]);
  return null;
}

describe("the export dialog", () => {
  it("summarises the file before writing anything, with no accessibility violations", async () => {
    const { view } = await editor();
    await userEvent.click(exportTool(view));
    const dialog = dialogOf(view);
    await eventually(() => expect(dialog.open).toBe(true));
    expect(dialog.textContent).toContain("Export the video");
    expect(dialog.textContent).toMatch(/× \d+ pixels, 30 frames per second, 0:02\.00 long/);
    expect(dialog.textContent).toContain("Nothing else from your original files is copied");
    expect(button(view, "Export")).toBeDefined();
    await settled(dialog);
    const result = await axe.run(dialog);
    expect(result.violations.map((each) => `${each.id}: ${each.help}`)).toEqual([]);
    // Cancel closes it, and focus goes back to the tool that opened it.
    await userEvent.click(button(view, "Cancel") as HTMLButtonElement);
    await eventually(() => expect(dialog.open).toBe(false));
    expect(document.activeElement).toBe(exportTool(view));
  });

  it("exports a file the SDK reads back, and hands it to a host's onExport", async () => {
    const file = await fixture();
    const exported: { blob: Blob; result: VideoExportResult }[] = [];
    const view = mount(
      <VideoEditorProvider>
        <Insert file={file} />
        <VideoToolbar />
        <VideoExportDialog onExport={(blob, result) => exported.push({ blob, result })} />
      </VideoEditorProvider>,
    );
    await eventually(() => expect(exportTool(view).getAttribute("aria-disabled")).toBeNull());
    await userEvent.click(exportTool(view));
    await userEvent.click(button(view, "Export") as HTMLButtonElement);
    await eventually(() => expect(exported).toHaveLength(1), 60_000);
    // The dialog closes once a host takes the file.
    await eventually(() => expect(dialogOf(view).open).toBe(false));
    const [{ blob, result }] = exported as [{ blob: Blob; result: VideoExportResult }];
    expect(result.size).toBe(blob.size);
    expect(blob.type).toContain(result.container);
    const engine = createVideoEngine();
    try {
      const probe = await engine.probe(blob);
      expect(probe.duration).toBeGreaterThan(1_900_000);
      expect(probe.duration).toBeLessThan(2_100_000);
    } finally {
      await engine.destroy();
    }
  });

  it("offers the file for download, focused, and says it's ready; Done closes it fresh", async () => {
    const { view } = await editor();
    await userEvent.click(exportTool(view));
    await userEvent.click(button(view, "Export") as HTMLButtonElement);
    const download = await eventually(() => {
      const found = button(view, "Download");
      expect(found).toBeDefined();
      return found as HTMLButtonElement;
    }, 60_000);
    await eventually(() => expect(document.activeElement).toBe(download));
    expect(dialogOf(view).textContent).toMatch(/Your (MP4|WebM) video is ready: /);
    await eventually(() => expect(announced(view)).toMatch(/video is ready/));
    expect(button(view, "Close")).toBeUndefined();
    await userEvent.click(button(view, "Done") as HTMLButtonElement);
    await eventually(() => expect(dialogOf(view).open).toBe(false));
    // Reopened, it's back at its summary.
    await userEvent.click(exportTool(view));
    await eventually(() => expect(button(view, "Export")).toBeDefined());
    expect(button(view, "Download")).toBeUndefined();
  });

  it("stops an export, says so, and keeps the dialog open at its summary", async () => {
    const { view } = await editor();
    await userEvent.click(exportTool(view));
    await userEvent.click(button(view, "Export") as HTMLButtonElement);
    const stop = await eventually(() => {
      const found = button(view, "Stop");
      expect(found).toBeDefined();
      return found as HTMLButtonElement;
    });
    await userEvent.click(stop);
    await eventually(() => expect(button(view, "Export")).toBeDefined());
    await eventually(() => expect(announced(view)).toContain("Export stopped."));
    expect(dialogOf(view).open).toBe(true);
    expect(view.querySelector('dialog [role="alert"]')).toBeNull();
  });

  it("drops an export it no longer owns when it's closed while exporting", async () => {
    const file = await fixture();
    const exported: Blob[] = [];
    const view = mount(
      <VideoEditorProvider>
        <Insert file={file} />
        <VideoToolbar />
        <VideoExportDialog onExport={(blob) => exported.push(blob)} />
      </VideoEditorProvider>,
    );
    await eventually(() => expect(exportTool(view).getAttribute("aria-disabled")).toBeNull());
    await userEvent.click(exportTool(view));
    await userEvent.click(button(view, "Export") as HTMLButtonElement);
    await eventually(() => expect(button(view, "Stop")).toBeDefined());
    // Escape closes it, which stops the export it started.
    await userEvent.keyboard("{Escape}");
    await eventually(() => expect(dialogOf(view).open).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(exported).toEqual([]);
    expect(announced(view)).not.toMatch(/ready|stopped/);
    // It reopens at its summary, and exports again.
    await userEvent.click(exportTool(view));
    await userEvent.click(button(view, "Export") as HTMLButtonElement);
    await eventually(() => expect(exported).toHaveLength(1), 60_000);
  });
});
