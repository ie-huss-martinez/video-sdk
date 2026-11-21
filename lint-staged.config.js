import { relative } from "node:path";
import preset from "@hussmartinez/sdk-config/lint-staged";

/**
 * The files hm-lint-react reads (sdk-core ADR 0063): published TypeScript
 * under `src`, without tests or stories. It fails on a file its
 * configuration ignores, so it's given only these.
 */
const PUBLISHED = /^src\/.*(?<!\.test|\.stories|\.d)\.tsx?$/;

/** @param {readonly string[]} files */
function lintReact(files) {
  const published = files
    .map((file) => relative(process.cwd(), file))
    .filter((file) => PUBLISHED.test(file));
  return published.length === 0 ? [] : [`hm-lint-react ${published.join(" ")}`];
}

// After Biome in the same list, which runs in order: the lint reads what
// Biome has written.
export default { ...preset, "!(*.css)": [...preset["!(*.css)"], lintReact] };
