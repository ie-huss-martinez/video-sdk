import "@hussmartinez/ui/styles.css";
import "../styles.css";
import axe from "axe-core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { createFakeOutput } from "../../test/fakes/fake-output.js";
import landscapeVp8 from "../../test/fixtures/video/landscape-vp8.webm?url";
import { VideoError } from "../core/errors/video-error.js";
import type { VideoOutput, VideoOutputSnapshot } from "../core/ports/video-output.js";
import { VideoEditor, type VideoEditorHandle } from "./VideoEditor.js";

// The stage with an output whose playback fails, as the real output's does
// when a worker call fails: paused, with the error in its snapshot. A real
// decoder can't be made to fail on demand, so the output is a fake here; the
// engine, the session and the rest of the editor are real.
vi.mock("../adapters/video-output.js", () => ({
  createVideoOutput: (): VideoOutput => {
    const { output } = createFakeOutput();
    let failure: VideoError | null = null;
    let inner = output.getSnapshot();
    let snapshot: VideoOutputSnapshot = inner;
    const listeners = new Set<() => void>();
    const publish = () => {
      inner = output.getSnapshot();
      snapshot = failure ? { ...inner, state: "paused", error: failure } : inner;
      for (const listener of [...listeners]) listener();
    };
    output.subscribe(publish);
    return {
      ...output,
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async play() {
        failure = new VideoError(
          "DECODE_FAILED",
          "The browser's decoder stopped producing frames for the video track.",
          { details: { codec: "vp8", reason: "stalled" } },
        );
        publish();
      },
    };
  },
}));

vi.setConfig({ testTimeout: 60_000 });

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

describe("the stage", () => {
  it("says when playback fails, at its foot, as an alert", async () => {
    const handle = createRef<VideoEditorHandle>();
    container = document.createElement("div");
    container.style.inlineSize = "640px";
    container.style.blockSize = "480px";
    document.body.append(container);
    act(() => {
      root = createRoot(container as HTMLElement);
      root.render(<VideoEditor ref={handle} />);
    });
    const blob = await (await fetch(landscapeVp8)).blob();
    await act(async () => {
      await (handle.current as VideoEditorHandle).insert(
        new File([blob], "landscape.webm", { type: "video/webm" }),
      );
    });
    const view = container;
    const play = () => view.querySelector('button[aria-label="Play"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(play()?.disabled).toBe(false), { timeout: 15_000 });
    expect(view.querySelector(".hm-video-stage-error")).toBeNull();

    await userEvent.click(play());
    const error = () => view.querySelector(".hm-video-stage-foot .hm-video-stage-error");
    await vi.waitFor(() => expect(error()).not.toBeNull());
    // Its text by code, never the error's own message.
    expect(error()?.textContent).toBe(
      "This browser couldn't play part of this video. Try another browser, or convert the file to MP4.",
    );
    expect(error()?.getAttribute("role")).toBe("alert");
    const result = await axe.run(view);
    expect(result.violations.map((each) => `${each.id}: ${each.help}`)).toEqual([]);
  });
});
