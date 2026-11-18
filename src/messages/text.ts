import { isSdkError, type Messages } from "@hussmartinez/sdk-core";
import type { VideoWarning } from "../core/model/warnings.js";
import { type VideoMessageCatalogue, videoMessages } from "./en.js";

/**
 * The user-facing text for an error: the catalogue's text for its code and
 * `details.reason` together, `errors.<CODE>.<reason>`, when there is one,
 * and otherwise `messages.error(error)`, the text for its code. So an output
 * over a limit says it's the output, rather than a video the user opened,
 * and an edit that would make the video too long says so. It's audio-sdk's
 * `audioErrorText`, for video. sdk-core's `messages.error()` may take over
 * this fallback for the family; until then, use this one.
 *
 * @example
 * ```ts
 * const messages = createMessages(videoMessages, { locale: "en" });
 * showError(videoErrorText(messages, error));
 * ```
 *
 * @public
 */
export function videoErrorText(messages: Messages<VideoMessageCatalogue>, error: unknown): string {
  if (isSdkError(error)) {
    const details = (error.details ?? {}) as { readonly reason?: unknown };
    if (typeof details.reason === "string") {
      const key = `errors.${error.code}.${details.reason}`;
      if (Object.hasOwn(videoMessages, key)) {
        // The key is one of the catalogue's, whose parameters come from the
        // same details as its code's text.
        const catalogue = messages as unknown as { t(key: string, params: object): string };
        return catalogue.t(key, details);
      }
    }
  }
  return messages.error(error);
}

/**
 * The user-facing text for one of the snapshot's warnings, from
 * `warnings.<limit>` with its value as `actual`, or `warnings.<type>` for
 * the others, such as `warnings.audioUndecodable`. A limit's name is known
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
  if (warning.type === "audioUndecodable") return messages.t("warnings.audioUndecodable");
  // Every limit's warning takes `actual`, or nothing, which ignores it.
  const catalogue = messages as unknown as { t(key: string, params: object): string };
  return catalogue.t(`warnings.${warning.limit}`, { actual: warning.actual });
}
