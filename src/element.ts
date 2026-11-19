/**
 * The `<hm-video-editor>` custom element of the video SDK.
 *
 * @remarks
 * Importing this entry registers nothing: applications call
 * `defineVideoEditorElement()` themselves, and importing it on a server does
 * nothing (sdk-core ADR 0004, ADR 0007). The element renders `<VideoEditor>`
 * into its light DOM, so React and React DOM, the package's optional peer
 * dependencies, are needed here. Hosts import `@hussmartinez/ui/styles.css`
 * once, then this package's `styles.css` (sdk-core ADR 0036).
 *
 * @packageDocumentation
 */

import { createEditorElement } from "@hussmartinez/sdk-core/element";
import type { VideoExportReport } from "./react/element/listeners.js";
import {
  mountVideoEditor,
  type VideoEditorElementEvent,
  type VideoEditorElementMethods,
  type VideoEditorElementProps,
} from "./react/element/mount.js";

export type {
  VideoEditorElementEvent,
  VideoEditorElementMethods,
  VideoEditorElementProps,
  VideoExportReport,
};

/** A space-separated list, as the `tools` attribute holds. */
const words = (value: string): readonly string[] => value.split(/\s+/).filter(Boolean);

/**
 * Registers `<hm-video-editor>`, or the tag you name, and returns its class
 * (docs/adr/0007, sdk-core ADR 0040), as audio-sdk's and image-sdk's
 * elements do: the attributes `theme`, `locale` and `tools`; the properties
 * `file`, `fileName`, `filePolicy`, `assetsUrl`, `messages`, `engine` and
 * `processor`; the methods `open`, `insert`, `export`, `undo`, `redo`,
 * `play`, `pause` and `seek`; and the events `hm-video-editor-change`, `-event`,
 * `-export` and `-error`. Calling it again returns the same class.
 *
 * @example
 * ```ts
 * import { defineVideoEditorElement } from "@hussmartinez/video-sdk/element";
 *
 * defineVideoEditorElement();
 * const editor = document.querySelector("hm-video-editor");
 * editor.file = file;
 * editor.addEventListener("hm-video-editor-change", (event) => save(event.detail));
 * ```
 *
 * @public
 */
export const defineVideoEditorElement = /* @__PURE__ */ createEditorElement<
  Partial<VideoEditorElementProps>,
  VideoEditorElementMethods,
  VideoEditorElementEvent
>({
  kind: "video",
  attributes: {
    theme: "theme",
    locale: "locale",
    tools: { property: "tools", parse: words },
  },
  properties: ["file", "fileName", "filePolicy", "assetsUrl", "messages", "engine", "processor"],
  methods: ["open", "insert", "export", "undo", "redo", "play", "pause", "seek"],
  events: ["change", "event", "export", "error"],
  mount: mountVideoEditor,
});
