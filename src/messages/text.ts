import type { Messages } from "@hussmartinez/sdk-core";
import type { VideoWarning } from "../core/model/warnings.js";
import type { VideoMessageCatalogue } from "./en.js";

/**
 * The user-facing text for one of the snapshot's warnings, from
 * `warnings.<limit>` with its value as `actual`. A limit's name is known
 * only at run time, which `messages.t()` can't type, so this does it once,
 * as audio-sdk's `audioWarningText` does for its warnings. sdk-core's
 * `messages.warning()` may take over for the family; until then, use this.
 *
 * @example
 * ```ts
 * const messages = createMessages(videoMessages, { locale: "en" });
 * for (const warning of snapshot.warnings) show(videoWarningText(messages, warning));
 * ```
 *
 * @public
 */
export function videoWarningText(
  messages: Messages<VideoMessageCatalogue>,
  warning: VideoWarning,
): string {
  // Every limit's warning takes `actual`, or nothing, which ignores it.
  const catalogue = messages as unknown as { t(key: string, params: object): string };
  return catalogue.t(`warnings.${warning.limit}`, { actual: warning.actual });
}
