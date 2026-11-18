/** Characters no common file system takes in a name, and control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;
/** Bidirectional overrides and isolates, which can make a name read as another. */
const BIDI = /[‪-‮⁦-⁩]/g;
/** The extensions of the containers the SDK reads and writes, which the export puts back. */
const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|mkv)$/i;
/** The longest name, in code points, before the extension. */
const MAX_NAME = 100;

/**
 * The name an export is downloaded under, without its extension
 * (docs/adr/0007): the host's `fileName`, or else the video's title, or
 * else "video". It's cleaned, because both are text from people: characters
 * file systems refuse, control characters and bidirectional overrides are
 * removed, a video extension the host left on is dropped, as the export
 * adds its own, and it's kept to 100 characters.
 *
 * @internal
 */
export function exportFileName(fileName: string | undefined, title: string): string {
  for (const candidate of [fileName, title]) {
    const clean = [
      ...(candidate ?? "").replace(UNSAFE, " ").replace(BIDI, "").replace(VIDEO_EXTENSION, ""),
    ]
      .slice(0, MAX_NAME)
      .join("")
      .replace(/\s+/g, " ")
      // Windows drops trailing dots and spaces, and a leading dot hides a file.
      .replace(/^[\s.]+|[\s.]+$/g, "");
    if (clean !== "") return clean;
  }
  return "video";
}
