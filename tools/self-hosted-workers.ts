import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type Rolldown } from "vite";

/** The package's version, which the workers announce and the clients check (sdk-core ADR 0038). */
export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** The compile-time constants for a build announcing `version`. */
export function versionDefine(version: string = PACKAGE_VERSION): Record<string, string> {
  return { __VIDEO_SDK_VERSION__: JSON.stringify(version) };
}

/** The self-hosted workers, by their file under `dist/assets/` (docs/adr/0002). */
export const SELF_HOSTED_WORKERS = {
  "video/media.worker.js": "src/workers/media.worker.ts",
  "video/export.worker.js": "src/workers/export.worker.ts",
} as const;

export type SelfHostedWorker = keyof typeof SELF_HOSTED_WORKERS;

/**
 * Builds one self-hosted worker: its entry point, with everything it imports,
 * as one minified ES module, keeping licence comments, so mediabunny's notice
 * stays with its code (docs/adr/0001), and without source maps.
 */
export async function buildSelfHostedWorker(
  file: SelfHostedWorker,
  version: string = PACKAGE_VERSION,
): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: { ...versionDefine(version), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: true,
      target: "es2022",
      sourcemap: false,
      lib: {
        entry: fileURLToPath(new URL(`../${SELF_HOSTED_WORKERS[file]}`, import.meta.url)),
        formats: ["es"],
        fileName: () => file,
      },
      rolldownOptions: {
        output: { codeSplitting: false, minify: true, comments: { legal: true } },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs.flatMap((output) => output.output).find((part) => part.type === "chunk");
  if (chunk?.type !== "chunk") throw new Error(`The self-hosted worker ${file} didn't build.`);
  return chunk.code;
}

/** Writes the self-hosted workers into `dist/assets/` (sdk-core ADR 0038). */
export function selfHostedWorkers(): Plugin {
  return {
    name: "hm-self-hosted-workers",
    async generateBundle() {
      for (const file of Object.keys(SELF_HOSTED_WORKERS) as SelfHostedWorker[]) {
        this.emitFile({
          type: "asset",
          fileName: `assets/${file}`,
          source: await buildSelfHostedWorker(file),
        });
      }
    },
  };
}

/**
 * For the browser tests only: serves the self-hosted workers exactly as the
 * build writes them, so self-hosted mode is tested with the real files.
 *
 * - `/hm-test-assets/`: as built.
 * - `/hm-test-assets-other-version/`: built announcing another version, to
 *   test that the clients refuse it.
 */
export function testAssets(): Plugin {
  const built = new Map<string, Promise<string>>();
  return {
    name: "hm-test-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/hm-test-assets(-other-version)?\/([^?]+)/.exec(request.url ?? "");
        const file = match?.[2] as SelfHostedWorker | undefined;
        if (!match || !file) return next();
        if (!(file in SELF_HOSTED_WORKERS)) {
          response.statusCode = 404;
          response.end();
          return;
        }
        const version = match[1] ? "0.0.0-other" : PACKAGE_VERSION;
        const key = `${version}:${file}`;
        if (!built.has(key)) built.set(key, buildSelfHostedWorker(file, version));
        (built.get(key) as Promise<string>).then(
          (code) => {
            response.setHeader("Content-Type", "text/javascript");
            response.end(code);
          },
          (error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          },
        );
      });
    },
  };
}
