import "@hussmartinez/ui/styles.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import landscapeVp8 from "../../../test/fixtures/video/landscape-vp8.webm?url";
import { VideoError } from "../../core/errors/video-error.js";
import type { VideoPlan } from "../../core/model/plan.js";
import type { VideoEngine } from "../../core/ports/video-engine.js";
import type { VideoProcessor } from "../../core/ports/video-processor.js";
import { defineVideoEditorElement } from "../../element.js";
import "../../styles.css";
import type { VideoEditorElementMethods, VideoEditorElementProps } from "./mount.js";

// The element renders on its own React root, as a host's page would: these
// tests watch it from outside, as audio-sdk's and image-sdk's element tests
// do, not through React's act(). Waits on the UI get 15 s, and waits on
// work, such as a file opening or an export, 30 s, as in the other files.
const UI_WAIT = 15_000;
const WORK_WAIT = 30_000;

type Editor = HTMLElement & Partial<VideoEditorElementProps> & VideoEditorElementMethods;

const editors: HTMLElement[] = [];
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function until(condition: () => boolean, what: string, timeout = UI_WAIT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (condition()) return;
  throw new Error(`timed out waiting for ${what}`);
}

/** The 2 s fixture, under a name no event may carry. */
async function video(): Promise<File> {
  const blob = await (await fetch(landscapeVp8)).blob();
  return new File([blob], "private-holiday.webm", { type: "video/webm" });
}

function create(attributes: Record<string, string> = {}): Editor {
  defineVideoEditorElement();
  const editor = document.createElement("hm-video-editor") as Editor;
  for (const [name, value] of Object.entries(attributes)) editor.setAttribute(name, value);
  editor.style.width = "900px";
  editor.style.height = "600px";
  editors.push(editor);
  return editor;
}

/** Every event's detail, by name, as JSON: what a host could send anywhere. */
function record(editor: HTMLElement) {
  const events: { name: string; detail: unknown; json: string }[] = [];
  for (const name of ["change", "event", "export", "error"]) {
    editor.addEventListener(`hm-video-editor-${name}`, (event) => {
      const { detail } = event as CustomEvent;
      events.push({ name, detail, json: JSON.stringify(detail) });
    });
  }
  return events;
}

const tool = (editor: HTMLElement, id: string) =>
  editor.querySelector<HTMLButtonElement>(`[data-hm-tool="${id}"]`);
const lastPlan = (events: ReturnType<typeof record>) =>
  events.filter((event) => event.name === "change").at(-1)?.detail as VideoPlan | undefined;
const clips = (events: ReturnType<typeof record>) => lastPlan(events)?.clips.length ?? 0;

describe("<hm-video-editor> (docs/adr/0007, sdk-core ADR 0040)", () => {
  it("registers once, and renders the editor into its light DOM", async () => {
    // Importing the entry registered nothing: defining it does.
    expect(customElements.get("hm-video-editor")).toBeUndefined();
    const Class = defineVideoEditorElement();
    expect(defineVideoEditorElement()).toBe(Class);
    expect(customElements.get("hm-video-editor")).toBe(Class);
    const editor = create();
    document.body.append(editor);
    await until(() => editor.querySelector("section") !== null, "the editor");
    expect(editor.shadowRoot).toBeNull();
    // The package's stylesheet makes it a block, which the host sizes.
    expect(getComputedStyle(editor).display).toBe("block");
    // The editor takes the height the host gives the element.
    expect(editor.querySelector("section")?.getBoundingClientRect().height).toBeCloseTo(600, 0);
    expect(editor.querySelector("section")?.getAttribute("aria-label")).toBe("Video editor");
  });

  // The one test here that does long work: it opens and inserts real videos,
  // plays, seeks and exports. It measured 29.1 s in one engine, half the
  // family's 60 s (sdk-core ADR 0057), so it keeps a longer limit.
  it("opens its file property, fires change with the plan, and forwards the handle's methods", async () => {
    const editor = create();
    const events = record(editor);
    document.body.append(editor);
    editor.file = await video();
    await until(() => clips(events) === 1, "the open", WORK_WAIT);
    const first = lastPlan(events)?.clips[0]?.source;

    // Setting another opens it in place of the plan: still one clip, from
    // the new file, and nothing to undo.
    editor.file = await video();
    await until(
      () => clips(events) === 1 && lastPlan(events)?.clips[0]?.source !== first,
      "the second open",
      WORK_WAIT,
    );
    expect(editor.undo()).toBe(false);

    // insert() adds a clip; undo() and redo() take it away and back.
    await editor.insert(await video());
    await until(() => clips(events) === 2, "the second insert", WORK_WAIT);
    expect(editor.undo()).toBe(true);
    await until(() => clips(events) === 1, "the undo");
    expect(editor.redo()).toBe(true);
    await until(() => clips(events) === 2, "the redo");

    // open() replaces the plan too, and resolves with the file's details.
    const opened = await editor.open(await video());
    expect(opened.duration).toBeGreaterThan(0);
    await until(() => clips(events) === 1, "the open() call", WORK_WAIT);
    expect(editor.undo()).toBe(false);
    await editor.insert(await video());
    await until(() => clips(events) === 2, "the insert after open()", WORK_WAIT);

    // play() plays with the editor's current output, not the first render's.
    await editor.play();
    await until(() => editor.querySelector('button[aria-label="Pause"]') !== null, "playing");
    editor.pause();
    await until(() => editor.querySelector('button[aria-label="Play"]') !== null, "paused");

    // Calls made in one task keep their order: play() then pause() ends paused.
    const playing = editor.play();
    editor.pause();
    await playing;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(editor.querySelector('button[aria-label="Pause"]')).toBeNull();

    editor.seek(30);
    await until(
      () => editor.querySelector(".hm-video-transport-time")?.textContent === "0:01.00 of 0:04.00",
      "the seek",
    );

    const exported = await editor.export({ container: "webm" });
    expect(exported.container).toBe("webm");
    expect(exported.blob.size).toBe(exported.size);

    // A host's usage events: anonymous, and never the file's name.
    expect(events.some((event) => event.name === "event")).toBe(true);
    for (const event of events) expect(event.json).not.toContain("private-holiday");
  }, 120_000);

  it("inserts through insert() as soon as it's connected, before its first render", async () => {
    const editor = create();
    const events = record(editor);
    document.body.append(editor);
    await editor.insert(await video());
    await until(() => clips(events) === 1, "the insert", WORK_WAIT);
  });

  it("rejects calls still waiting for the editor when it's removed before rendering", async () => {
    const file = await video();
    const editor = create();
    document.body.append(editor);
    const waiting = [editor.open(file), editor.insert(file), editor.play()];
    editor.remove();
    for (const call of waiting) {
      await expect(call).rejects.toMatchObject({ code: "ABORTED", details: { reason: "removed" } });
    }
  });

  it("settles play() when the preview can't play, as with a host's own engine", async () => {
    const editor = create();
    editor.engine = {
      probe: vi.fn(),
      open: vi.fn(),
      peaks: vi.fn(),
      close: vi.fn(),
      destroy: vi.fn(async () => {}),
    } as unknown as VideoEngine;
    document.body.append(editor);
    // It does nothing, as the handle's play() does without an output, but it
    // returns rather than waiting for an output that never comes.
    const settled = await Promise.race([
      editor.play().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), UI_WAIT)),
    ]);
    expect(settled).toBe("settled");
    expect(editor.textContent).toContain("The preview isn't available with this engine.");
  });

  it("takes theme, locale and tools from attributes, and follows their changes", async () => {
    const editor = create({ theme: "dark", tools: "video.undo video.redo" });
    document.body.append(editor);
    await until(() => tool(editor, "video.undo") !== null, "the tools");
    expect(editor.getAttribute("data-hm-theme")).toBe("dark");
    expect(tool(editor, "video.export")).toBeNull();

    editor.setAttribute("theme", "light");
    editor.setAttribute("tools", "video.export");
    await until(() => tool(editor, "video.export") !== null, "the new tools");
    expect(editor.getAttribute("data-hm-theme")).toBe("light");
    expect(tool(editor, "video.undo")).toBeNull();
    editor.removeAttribute("theme");
    await until(() => !editor.hasAttribute("data-hm-theme"), "the inherited theme");
  });

  it("fires error with the code and no name, for a file it can't open", async () => {
    const editor = create();
    const events = record(editor);
    document.body.append(editor);
    editor.file = new File([new Uint8Array([1, 2, 3, 4])], "private-holiday.webm", {
      type: "video/webm",
    });
    await until(() => events.some((event) => event.name === "error"), "the error", WORK_WAIT);
    const error = events.find((event) => event.name === "error")?.detail as { code: string };
    expect(error.code).toMatch(/^[A-Z_]+$/);
    for (const event of events) expect(event.json).not.toContain("private-holiday");
  });

  it("fires export after the dialog's export, with a report and no file", async () => {
    const editor = create();
    const events = record(editor);
    document.body.append(editor);
    editor.file = await video();
    await until(() => clips(events) === 1, "the insert", WORK_WAIT);
    await until(
      () => tool(editor, "video.export")?.getAttribute("aria-disabled") !== "true",
      "Export",
    );
    tool(editor, "video.export")?.click();
    await until(() => editor.querySelector("dialog[open]") !== null, "the dialog");
    const confirm = [...editor.querySelectorAll<HTMLButtonElement>("dialog button")].find(
      (element) => element.textContent === "Export",
    );
    confirm?.click();
    await until(() => events.some((event) => event.name === "export"), "the export", WORK_WAIT);
    const report = events.find((event) => event.name === "export")?.detail as Record<
      string,
      unknown
    >;
    expect(report).toMatchObject({ clippedFrames: 0 });
    expect(["mp4", "webm"]).toContain(report["container"]);
    expect(report["size"]).toBeGreaterThan(0);
    expect(Object.values(report).some((value) => value instanceof Blob)).toBe(false);
    for (const event of events) expect(event.json).not.toContain("private-holiday");
  });

  it("fires error once for an export the dialog shows failing", async () => {
    const editor = create();
    editor.processor = {
      export: () =>
        Promise.reject(
          new VideoError("UNSUPPORTED_CODEC", "No encoder.", { details: { track: "video" } }),
        ),
      destroy: async () => {},
    } satisfies VideoProcessor;
    const events = record(editor);
    document.body.append(editor);
    editor.file = await video();
    await until(() => clips(events) === 1, "the open", WORK_WAIT);
    await until(
      () => tool(editor, "video.export")?.getAttribute("aria-disabled") !== "true",
      "Export",
    );
    tool(editor, "video.export")?.click();
    await until(() => editor.querySelector("dialog[open]") !== null, "the dialog");
    const confirm = [...editor.querySelectorAll<HTMLButtonElement>("dialog button")].find(
      (element) => element.textContent === "Export",
    );
    confirm?.click();
    await until(() => events.some((event) => event.name === "error"), "the error", WORK_WAIT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const errors = events.filter((event) => event.name === "error");
    expect(errors.map((event) => event.detail)).toEqual([
      { code: "UNSUPPORTED_CODEC", details: { track: "video" } },
    ]);
    expect(events.some((event) => event.name === "export")).toBe(false);
  });

  it("keeps the editor across a move, and tears it down when removed", async () => {
    const editor = create();
    const events = record(editor);
    document.body.append(editor);
    editor.file = await video();
    await until(() => clips(events) === 1, "the insert", WORK_WAIT);
    const section = editor.querySelector("section");
    // A move within the document keeps the same editor and its clip.
    const holder = document.createElement("div");
    document.body.append(holder);
    holder.append(editor);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editor.querySelector("section")).toBe(section);
    expect(editor.querySelector('[role="option"]')).not.toBeNull();
    // Removal tears it down.
    editor.remove();
    holder.remove();
    await until(() => editor.querySelector("section") === null, "the teardown");
  });
});
