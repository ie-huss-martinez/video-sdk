import type { MessageOverrides, Messages } from "@hussmartinez/sdk-core";
import type { uiMessages } from "@hussmartinez/ui";
import type { videoEditorText } from "./editor-en.js";
import type { videoMessages } from "./en.js";

/**
 * The shape of the editor's catalogue, `videoEditorMessages` from
 * `./react`: the SDK's messages, `ui`'s for its own components, and the
 * editor's interface text, as one catalogue for one `Messages` object
 * (sdk-core ADR 0046, ADR 0059). A host types overrides of the editor's text
 * with `MessageOverrides<VideoEditorMessageCatalogue>`. Exported here, from
 * the main entry, because the React entry and the element both use it
 * (sdk-core ADR 0033), and a type costs no bytes.
 *
 * @public
 */
export type VideoEditorMessageCatalogue = typeof videoMessages &
  typeof uiMessages &
  typeof videoEditorText;

/**
 * The editor's catalogue's shape, under its old name.
 *
 * @deprecated Use {@link VideoEditorMessageCatalogue}, the family's name for
 * it (sdk-core ADR 0059). This alias goes in the next breaking minor.
 *
 * @public
 */
export type VideoEditorCatalogue = VideoEditorMessageCatalogue;

/**
 * The text the editor uses: its catalogue's `Messages`.
 *
 * @deprecated Use `Messages<VideoEditorMessageCatalogue>` (sdk-core ADR 0059).
 * This alias goes in the next breaking minor.
 *
 * @public
 */
export type VideoEditorMessages = Messages<VideoEditorMessageCatalogue>;

/**
 * A host's overrides of the editor's text, keyed as in `videoEditorMessages`.
 *
 * @deprecated Use `MessageOverrides<VideoEditorMessageCatalogue>` (sdk-core
 * ADR 0059). This alias goes in the next breaking minor.
 *
 * @public
 */
export type VideoEditorMessageOverrides = MessageOverrides<VideoEditorMessageCatalogue>;
