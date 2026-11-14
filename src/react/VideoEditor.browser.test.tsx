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
    const view = render(<VideoEditor ref={handle} />);
    const input = view.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, new File(["not a video"], "notes.webm", { type: "video/webm" }));
    const error = await vi.waitFor(
      () => {
        const found = view.querySelector(".hm-video-stage-error");
        expect(found).not.toBeNull();
        return found as HTMLElement;
      },
      { timeout: 15_000 },
    );
    // Within the drop zone, by the button that retries, and still an alert.
    expect(view.querySelector(".hm-video-stage-drop")?.contains(error)).toBe(true);
    expect(error.getAttribute("role")).toBe("alert");
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
