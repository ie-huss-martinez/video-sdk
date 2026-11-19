import type { MessageOverrides, Messages } from "@hussmartinez/sdk-core";
import type { uiMessages } from "@hussmartinez/ui";
import type { videoMessages } from "./en.js";

/**
 * The shape of the editor's catalogue: the SDK's messages, and `ui`'s for
 * its own components, as one catalogue for one `Messages` object (sdk-core
 * ADR 0046). Exported here, from the main entry, because the React entry
 * and the element both use it (sdk-core ADR 0033).
 *
 * @public
 */
export type VideoEditorCatalogue = typeof videoMessages & typeof uiMessages;

/**
 * The text the editor uses: the SDK's catalogue with `ui`'s.
 *
 * @public
 */
export type VideoEditorMessages = Messages<VideoEditorCatalogue>;

/**
 * A host's overrides of the editor's text, keyed as in `videoMessages`, and
 * `ui`'s keys, such as `fileDropZone.choose`, for its components in the
 * editor.
 *
 * @public
 */
export type VideoEditorMessageOverrides = MessageOverrides<VideoEditorCatalogue>;
