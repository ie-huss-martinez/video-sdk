// Copies the package's built workers to public/video-sdk/, where the
// self-hosted page serves them, as a host self-hosting them would
// (docs/adr/0002 in the package).
import { cpSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@hussmartinez/video-sdk/package.json"));
const target = fileURLToPath(new URL("../public/video-sdk", import.meta.url));
rmSync(target, { recursive: true, force: true });
cpSync(join(root, "dist/assets/video"), join(target, "video"), { recursive: true });
