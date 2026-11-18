import "@hussmartinez/ui/styles.css";
import "../styles.css";
import axe from "axe-core";
import { act, createRef, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import type { VideoEngine } from "../core/ports/video-engine.js";
import { VideoEditor, type VideoEditorHandle } from "./VideoEditor.js";

// The editor runs real decoding and playback in workers, and a heavily
// loaded machine slows them several times over: a minute per test, so that
// load fails a test only through its own checks.
vi.setConfig({ testTimeout: 60_000 });

// The editor shell (docs/adr/0007): its states, accessibility and lifecycle,
// over the SDK's real engine and output.

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
  // Let the provider's deferred release run.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  container.style.inlineSize = "640px";
  container.style.blockSize = "480px";
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(element);
  });
  return container;
}

async function violations(element: HTMLElement): Promise<string[]> {
  const result = await axe.run(element);
  return result.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

const fixture = async () => {
  const blob = await (await fetch(landscapeVp8)).blob();
  return new File([blob], "landscape.webm", { type: "video/webm" });
};

describe("the video editor", () => {
  it("shows the drop zone when empty, with no accessibility violations", async () => {
    const view = render(<VideoEditor />);
    const editor = view.querySelector("section") as HTMLElement;
    expect(editor.getAttribute("aria-label")).toBe("Video editor");
    expect(view.querySelector(".hm-video-stage-drop")).not.toBeNull();
    expect(view.textContent).toContain("Add a video to start editing.");
    // The transport is there, and off, until there's something to play.
    const play = view.querySelector('button[aria-label="Play"]') as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    expect(await violations(view)).toEqual([]);
  });

  it("inserts a file from the drop zone's file picker, and names the preview as an image", async () => {
    const view = render(<VideoEditor />);
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, await fixture());
    const canvas = await vi.waitFor(
      () => {
        const found = view.querySelector("canvas.hm-video-stage-canvas");
        expect(found?.getAttribute("aria-label")).toBe("Video preview, frame 1 of 60");
        return found as HTMLCanvasElement;
      },
      { timeout: 10_000 },
    );
    expect(canvas.getAttribute("role")).toBe("img");
    expect(view.querySelector(".hm-video-stage-drop")).toBeNull();
    expect(view.querySelector(".hm-video-transport-time")?.textContent).toBe("0:00.00 of 0:02.00");
    expect(await violations(view)).toEqual([]);
  });

  it("plays and pauses from the transport, and steps a frame", async () => {
    const view = render(<VideoEditor initialFiles={[await fixture()]} />);
    const play = await vi.waitFor(
      () => {
        const button = view.querySelector('button[aria-label="Play"]') as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        return button;
      },
      { timeout: 10_000 },
    );
    await userEvent.click(play);
    await vi.waitFor(
      () =>
        expect(view.querySelector('button[aria-label="Pause"]')?.getAttribute("aria-pressed")).toBe(
          "true",
        ),
      { timeout: 15_000 },
    );
    await vi.waitFor(
      () =>
        expect(view.querySelector(".hm-video-transport-time")?.textContent).not.toMatch(
          /^0:00\.00/,
        ),
      { timeout: 15_000 },
    );
    // From the keyboard, as a keyboard user does: a pointer click waits for
    // the button to hold still across frames, which a loaded runner, with the
    // time redrawn every frame, can take most of a minute to see.
    (view.querySelector('button[aria-label="Pause"]') as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    (view.querySelector('button[aria-label="Previous frame"]') as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(
      () =>
        expect(view.querySelector('button[aria-label="Play"]')?.getAttribute("aria-pressed")).toBe(
          "false",
        ),
      { timeout: 15_000 },
    );
  });

  it("shows a failed first open inside the drop zone, and a later failure over the clips", async () => {
    const handle = createRef<VideoEditorHandle>();
    const onEvent = vi.fn();
    const view = render(<VideoEditor ref={handle} onEvent={onEvent} />);
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    // The picker returns before the worker rejects the file. Keep that
    // completion inside act, then inspect the committed alert below.
    await act(async () => {
      await userEvent.upload(
        input,
        new File(["not a video"], "notes.webm", { type: "video/webm" }),
      );
      await vi.waitFor(
        () =>
          expect(onEvent).toHaveBeenCalledWith({
            type: "insert",
            outcome: "failed",
            commands: [],
          }),
        { timeout: 15_000 },
      );
    });
    const error = view.querySelector(".hm-video-stage-error");
    expect(error).not.toBeNull();
    // Within the drop zone, by the button that retries, and still an alert.
    expect(view.querySelector(".hm-video-stage-drop")?.contains(error)).toBe(true);
    expect(error?.getAttribute("role")).toBe("alert");
    expect(await violations(view)).toEqual([]);
    // With a clip open, a failure is a banner over the stage instead.
    await act(async () => {
      await (handle.current as VideoEditorHandle).insert(await fixture());
    });
    await act(async () => {
      await (handle.current as VideoEditorHandle)
        .insert(new File(["still not a video"], "more.webm", { type: "video/webm" }))
        .catch(() => {});
    });
    await vi.waitFor(() => expect(view.querySelector(".hm-video-stage-error")).not.toBeNull(), {
      timeout: 15_000,
    });
    expect(view.querySelector(".hm-video-stage-drop")).toBeNull();
    expect(view.querySelector(".hm-video-stage-error")?.getAttribute("role")).toBe("alert");
  });

  it("shows the session's warnings over the stage, announces each once, and dismisses it", async () => {
    const handle = createRef<VideoEditorHandle>();
    // Any video is "long" with a 1 ms warning, so opening the fixture warns.
    const view = render(
      <VideoEditor
        ref={handle}
        filePolicy={{ maxDuration: { maximum: 3 * 60 * 60 * 1000, warning: 1 } }}
      />,
    );
    // Every message the polite region says, as a screen reader hears it: ui's
    // announcer keeps only the latest of a frame, so spying on announce()
    // wouldn't show a warning that another message replaced.
    const said: string[] = [];
    const region = document.querySelector(".hm-announcer [aria-live=polite]") as Element;
    const observer = new MutationObserver(() => {
      if (region.textContent) said.push(region.textContent);
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    const text = "This video is long, and may be slow to open and save.";
    const warnings = () => said.filter((each) => each.includes(text));

    await act(async () => {
      await (handle.current as VideoEditorHandle).insert(await fixture());
    });
    const notices = () => view.querySelector(".hm-video-stage-notices");
    await vi.waitFor(() => expect(notices()).not.toBeNull(), { timeout: 15_000 });
    expect(notices()?.getAttribute("aria-label")).toBe("Notices");
    expect(notices()?.textContent).toContain(text);
    // The file is long and so is the video it makes: two warnings of one kind, one notice.
    expect(notices()?.querySelectorAll("li")).toHaveLength(1);
    // At the foot of the stage, with no failure there.
    expect(view.querySelector(".hm-video-stage-foot")?.contains(notices())).toBe(true);
    expect(view.querySelector(".hm-video-stage-error")).toBeNull();
    await vi.waitFor(() => expect(warnings()).toHaveLength(1));
    expect(await violations(view)).toEqual([]);

    await userEvent.click(
      notices()?.querySelector("button[aria-label='Dismiss']") as HTMLButtonElement,
    );
    await vi.waitFor(() => expect(notices()).toBeNull());
    // Undone and redone, the warning is in the snapshot again: dismissed, it
    // stays hidden, and it's never said again.
    await act(async () => {
      (handle.current as VideoEditorHandle).undo();
    });
    await act(async () => {
      (handle.current as VideoEditorHandle).redo();
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(notices()).toBeNull();
    expect(warnings()).toHaveLength(1);
    observer.disconnect();
  });

  it("keeps one canvas through StrictMode's second mount, and removes it on unmount", async () => {
    const view = render(
      <StrictMode>
        <VideoEditor initialFiles={[await fixture()]} />
      </StrictMode>,
    );
    await vi.waitFor(
      () => expect(view.querySelector("canvas")?.getAttribute("aria-label")).toBeTruthy(),
      {
        timeout: 10_000,
      },
    );
    expect(view.querySelectorAll("canvas")).toHaveLength(1);
    act(() => root?.unmount());
    root = undefined;
    expect(view.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("shows its own text in ui's type and colour, not the host page's", () => {
    const view = render(<VideoEditor />);
    view.style.font = '31px/3 "Times New Roman", serif';
    view.style.color = "rgb(1, 2, 3)";
    // What ui's tokens give, read from an element that only names them.
    const probe = document.createElement("div");
    probe.style.cssText =
      "font-family: var(--hm-font-family); font-size: var(--hm-font-size-body); line-height: var(--hm-line-height-body); color: var(--hm-color-text)";
    view.append(probe);
    const editor = view.querySelector(".hm-video-editor") as HTMLElement;
    expect(editor.classList.contains("hm-text")).toBe(true);
    const shown = getComputedStyle(editor);
    const tokens = getComputedStyle(probe);
    for (const property of ["fontFamily", "fontSize", "lineHeight", "color"] as const) {
      expect(shown[property], property).toBe(tokens[property]);
    }
    expect(shown.fontSize).not.toBe("31px");
    expect(shown.color).not.toBe("rgb(1, 2, 3)");
  });

  it("puts the inspector under the timeline in a narrow container, and beside the regions in a wide one", async () => {
    const view = render(<VideoEditor initialFiles={[await fixture()]} />);
    await vi.waitFor(() => expect(view.querySelector(".hm-video-inspector")).not.toBeNull(), {
      timeout: 15_000,
    });
    const box = (selector: string) =>
      (view.querySelector(selector) as HTMLElement).getBoundingClientRect();
    // 640 px, under the 720 px of docs/adr/0007.
    expect(box(".hm-video-inspector").top).toBeGreaterThanOrEqual(box(".hm-video-timeline").bottom);
    expect(box(".hm-video-inspector").width).toBeCloseTo(box(".hm-video-timeline").width, 0);
    view.style.inlineSize = "960px";
    await vi.waitFor(() =>
      expect(box(".hm-video-inspector").left).toBeGreaterThanOrEqual(
        box(".hm-video-timeline").right,
      ),
    );
    expect(box(".hm-video-inspector").top).toBeCloseTo(box(".hm-video-toolbar").top, 0);
    // The other regions keep the first column to themselves.
    expect(box(".hm-video-stage").right).toBeLessThanOrEqual(box(".hm-video-inspector").left);
  });

  it("exports from its handle, without the dialog or onExport, and with sound left out when asked", async () => {
    const handle = createRef<VideoEditorHandle>();
    const exported: Blob[] = [];
    const view = render(
      <VideoEditor
        ref={handle}
        initialFiles={[await fixture()]}
        onExport={(blob) => exported.push(blob)}
      />,
    );
    await vi.waitFor(() => expect(view.querySelector('[role="option"]')).not.toBeNull(), {
      timeout: 15_000,
    });
    const editor = handle.current as VideoEditorHandle;
    const progress: number[] = [];
    const result = await editor.export({ onProgress: (fraction) => progress.push(fraction) });
    expect(result.size).toBe(result.blob.size);
    expect(["mp4", "webm"]).toContain(result.container);
    expect(result.clippedFrames).toBe(0);
    expect(progress.at(-1)).toBe(1);
    // The host has the file from the call: no dialog, and onExport isn't called.
    expect(view.querySelector("dialog")?.open ?? false).toBe(false);
    expect(exported).toEqual([]);
    // Without sound when asked: silence.
    const silent = await editor.export({ audio: "omit" });
    expect(silent.peakDb).toBe(Number.NEGATIVE_INFINITY);
    // Cancelled, it rejects with ABORTED.
    const controller = new AbortController();
    controller.abort();
    await expect(editor.export({ signal: controller.signal })).rejects.toMatchObject({
      code: "ABORTED",
    });
  });

  it("renders on a server, with no canvas", () => {
    const html = renderToString(<VideoEditor />);
    expect(html).toContain("hm-video-editor");
    expect(html).not.toContain("<canvas");
  });

  it("says when the preview can't play from a host's own engine", async () => {
    const engine = {
      probe: vi.fn(),
      open: vi.fn(),
      peaks: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(async () => {}),
    } as unknown as VideoEngine;
    const view = render(<VideoEditor engine={engine} />);
    await vi.waitFor(() =>
      expect(view.textContent).toContain("The preview isn't available with this engine."),
    );
    expect(view.querySelector("canvas")).toBeNull();
  });
});
