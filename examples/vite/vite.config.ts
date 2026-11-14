import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * Serves the package's `dist/assets/` under `/video-sdk/`, as a host
 * self-hosting the workers would (docs/adr/0002 in the package).
 */
function videoSdkAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@hussmartinez/video-sdk/package.json"));
  const workers = ["video/media.worker.js", "video/export.worker.js"];
  return {
    name: "copy-video-sdk-assets",
    generateBundle() {
      for (const worker of workers) {
        this.emitFile({
          type: "asset",
          fileName: `video-sdk/${worker}`,
          source: readFileSync(join(root, "dist/assets", worker)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [videoSdkAssets()],
  build: {
    target: "es2022",
    rollupOptions: {
      // The client entries say "use client", which a bundle for the browser
      // only has no use for: that's expected here, not a problem to report.
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
      input: {
        index: "index.html",
        inline: "inline.html",
        "self-hosted": "self-hosted.html",
      },
    },
  },
});
