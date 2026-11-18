import { cleanFileName } from "../../core/session/source-name.js";

/** The extensions of the containers the SDK reads and writes, which the export puts back. */
const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|mkv)$/iu;

/** A name cleaned as the family cleans one, then without a video extension. */
function withoutVideoExtension(raw: string | undefined): string | undefined {
  const clean = cleanFileName(raw);
  return clean === undefined ? undefined : cleanFileName(clean.replace(VIDEO_EXTENSION, ""));
}

/**
 * The name an export is downloaded under, without its extension
 * (docs/adr/0007): the host's `fileName`, or else the video's title, or
 * else "video". Both are cleaned as the family cleans a file name
 * ([pdf-sdk ADR 0009](https://github.com/ie-huss-martinez/pdf-sdk/blob/main/docs/adr/0009-saving-the-document.md)):
 * the last path segment only, without control or bidirectional formatting
 * characters or the characters Windows refuses, without leading dots, and
 * at most 128 code points. Then a video extension the host left on is
 * dropped, as the export adds its own.
 *
 * @internal
 */
export function exportFileName(fileName: string | undefined, title: string): string {
  return withoutVideoExtension(fileName) ?? withoutVideoExtension(title) ?? "video";
}
