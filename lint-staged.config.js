import { extname, relative, sep } from "node:path";
import preset from "@hussmartinez/sdk-config/lint-staged";

/**
 * The React lint (sdk-core ADR 0063), when a commit stages TypeScript under
 * `src`. It runs on all of the published source, in about three seconds,
 * rather than on the staged files: its configuration decides which files it
 * reads, without tests, stories or fixtures, and it fails on a file it's
 * given but ignores. Giving it no paths also keeps file names out of the
 * command line, which lint-staged would split at spaces.
 */
function lintReact(/** @type {readonly string[]} */ files) {
  const source = files.some((file) => {
    const path = relative(process.cwd(), file).split(sep);
    return path[0] === "src" && [".ts", ".tsx"].includes(extname(file));
  });
  return source ? ["hm-lint-react"] : [];
}

// After Biome in the same list, which runs in order: the lint reads what
// Biome has written.
export default { ...preset, "!(*.css)": [...preset["!(*.css)"], lintReact] };
