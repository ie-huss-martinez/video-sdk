import "@hussmartinez/ui/styles.css";
import "../styles.css";
import { AnnouncerProvider } from "@hussmartinez/ui/react";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoEngine } from "../core/ports/video-engine.js";
import type {
  VideoOutput,
  VideoOutputAudio,
  VideoOutputSnapshot,
} from "../core/ports/video-output.js";
import { useVideoEditor, VideoEditorProvider } from "./context.js";
import { VideoTransport } from "./VideoTransport.js";

// The transport's notices about sound (docs/adr/0006, docs/adr/0007): an
// output the test drives stands in for the stage's, through the editor's
// own seam, so each state of `audio` can be shown without a browser that
// blocks autoplay or a decoder that stalls.

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** An output whose snapshot the test sets; the transport only reads it. */
function fakeOutput() {
  const listeners = new Set<() => void>();
  let snapshot: VideoOutputSnapshot = {
    state: "playing",
    droppedFrames: 0,
    error: null,
    audio: "ready",
  };
  const output = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    position: () => 0,
    on: () => () => {},
    play: async () => {},
    pause() {},
    stop() {},
    seek() {},
    step() {},
    load() {},
  } as unknown as VideoOutput;
  return {
    output,
    setAudio(audio: VideoOutputAudio) {
      snapshot = { ...snapshot, audio };
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}

/** Puts the test's output where the stage would put its own. */
function WithOutput({ output }: { readonly output: VideoOutput }) {
  const { setOutput } = useVideoEditor();
  useEffect(() => {
    setOutput(output);
  }, [output, setOutput]);
  return null;
}

/** An engine that's never used: no file is opened here. */
const engine = {
  probe: vi.fn(),
  open: vi.fn(),
  peaks: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(async () => {}),
} as unknown as VideoEngine;

function mount(output: VideoOutput): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLElement);
    root.render(
      <VideoEditorProvider engine={engine}>
        <AnnouncerProvider>
          <WithOutput output={output} />
          <VideoTransport />
        </AnnouncerProvider>
      </VideoEditorProvider>,
    );
  });
  return container;
}

const note = (view: HTMLElement) =>
  view.querySelector(".hm-video-transport-note")?.textContent ?? null;
const announced = (view: HTMLElement) =>
  [...view.querySelectorAll(".hm-announcer [aria-live]")].map((each) => each.textContent).join(" ");

describe("the transport's notices about sound", () => {
  it("shows and announces each notice once as it appears, and neither while sound plays", async () => {
    const { output, setAudio } = fakeOutput();
    const view = mount(output);
    await vi.waitFor(() => expect(view.querySelector(".hm-video-transport")).not.toBeNull());
    expect(note(view)).toBeNull();

    setAudio("blocked");
    expect(note(view)).toBe("Sound is off: press play to turn it on.");
    await vi.waitFor(() => expect(announced(view)).toContain("Sound is off"));

    setAudio("undecodable");
    expect(note(view)).toBe("The sound couldn't be decoded, so the video plays without it.");
    await vi.waitFor(() => expect(announced(view)).toContain("couldn't be decoded"));

    // Once each: a re-render with the same state announces nothing new.
    const before = announced(view);
    setAudio("undecodable");
    expect(announced(view)).toBe(before);

    setAudio("ready");
    expect(note(view)).toBeNull();
  });

  it("isn't a live region itself, so a notice isn't announced twice", async () => {
    const { output, setAudio } = fakeOutput();
    const view = mount(output);
    setAudio("blocked");
    await vi.waitFor(() => expect(note(view)).not.toBeNull());
    const shown = view.querySelector(".hm-video-transport-note") as HTMLElement;
    expect(shown.getAttribute("role")).toBeNull();
    expect(shown.getAttribute("aria-live")).toBeNull();
  });
});
