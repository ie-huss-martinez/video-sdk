import type { Messages } from "@hussmartinez/sdk-core";
import type { VideoWarning } from "../core/model/warnings.js";
import type { VideoMessageCatalogue } from "./en.js";

/**
 * The user-facing text for an error: `messages.error(error)`, which looks up
 * the catalogue's text for its code and `details.reason` together,
 * `errors.<CODE>.<reason>`, before the text for its code (sdk-core ADR 0050).
 *
 * @deprecated Call `messages.error(error)` instead: it gives the same text
 * since sdk-core 0.4.6. This stays for existing callers.
 *
 * @public
 */
export function videoErrorText(messages: Messages<VideoMessageCatalogue>, error: unknown): string {
  return messages.error(error);
}

/**
 * The user-facing text for one of the snapshot's warnings:
 * `messages.warning(warning)`, from `warnings.<limit>` with its value as
 * `actual`, or `warnings.<type>` for the others, such as
 * `warnings.audioUndecodable` (sdk-core ADR 0050).
 *
 * @deprecated Call `messages.warning(warning)` instead: it gives the same
 * text since sdk-core 0.4.6. This stays for existing callers.
 *
 * @public
 */
export function videoWarningText(
  messages: Messages<VideoMessageCatalogue>,
  warning: VideoWarning,
): string {
  return messages.warning(warning);
}
