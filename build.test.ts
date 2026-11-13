import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Rolldown } from "vite";
import { afterAll, describe, expect, it } from "vitest";
import { externalPackages } from "./vite.config.js";

/**
 * Builds the package in memory with its real Vite config, so these checks see
 * exactly what dist/ would contain without writing to it.
 */
async function buildInMemory(): Promise<Array<Rolldown.OutputChunk | Rolldown.OutputAsset>> {
  const result = await build({
    configFile: new URL("vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) => ("output" in output ? output.output : []));
}

const files = await buildInMemory();

/**
 * What an entry loads lazily: the `import()`s of the entry and of the shared
 * chunks it loads. Code that two entries use goes in shared chunks, and its
 * `import()`s go with it.
 */
function lazyImports(entry: string): string[] {
  const seen = new Set<string>();
  const lazy = new Set<string>();
  const visit = (fileName: string) => {
    if (seen.has(fileName)) return;
    seen.add(fileName);
    const found = chunk(fileName);
    for (const name of found.dynamicImports) lazy.add(name);
    for (const name of found.imports) if (name.startsWith("shared/")) visit(name);
  };
  visit(entry);
  return [...lazy];
}

/** The code of an entry and the shared chunks it loads. */
function entryCode(entry: string): string {
  const parts = [chunk(entry).code];
  for (const name of chunk(entry).imports) {
    if (name.startsWith("shared/")) parts.push(chunk(name).code);
  }
  return parts.join("\n");
}

function chunk(fileName: string): Rolldown.OutputChunk {
  const found = files.find((file) => file.fileName === fileName);
  if (found?.type !== "chunk") {
    throw new Error(`${fileName} wasn't built as a JavaScript chunk`);
  }
  return found;
}

describe("the built package", () => {
  it('starts the React entry with "use client" (ADR 0007)', () => {
    expect(chunk("react.js").code).toMatch(/^"use client";\n/);
  });

  it('keeps "use client" out of the core and element entries (ADR 0004)', () => {
    expect(chunk("index.js").code).not.toContain("use client");
    expect(chunk("element.js").code).not.toContain("use client");
  });

  it("emits the stylesheet as its own file", () => {
    const styles = files.find((file) => file.fileName === "styles.css");
    expect(styles?.type).toBe("asset");
  });

  it("imports sdk-core and React instead of bundling them", () => {
    expect(externalPackages).toEqual(
      expect.arrayContaining(["@hussmartinez/sdk-core", "react", "react-dom"]),
    );
    expect(chunk("index.js").code).toContain('from "@hussmartinez/sdk-core"');
    for (const file of files) {
      if (file.type === "chunk") {
        // Bundled React or sdk-core would bring their own copies of these, and
        // a page with several SDKs would load sdk-core more than once.
        expect(file.code, file.fileName).not.toContain("react.transitional.element");
        expect(file.code, file.fileName).not.toContain("class SdkError");
      }
    }
  });

  it("uses the production JSX runtime and leaks no local paths", () => {
    const code = files.flatMap((file) => (file.type === "chunk" ? [file.code] : [])).join("\n");
    expect(code).not.toContain("jsx-dev-runtime");
    expect(code).not.toContain(process.cwd());
  });

  it("never imports CSS from JavaScript (ADR 0004)", () => {
    const javascript = files.filter((file) => file.type === "chunk");
    expect(javascript.length).toBeGreaterThan(0);
    for (const file of javascript) {
      expect(file.imports.filter((name) => name.endsWith(".css"))).toEqual([]);
      expect(file.code).not.toMatch(/import\s*["'][^"']+\.css["']/);
    }
  });
});

/**
 * Builds the package to a temporary folder inside the repository, so the
 * built files resolve their external imports from its node_modules, as they
 * would in an application.
 */
const temporaryBuild = (async () => {
  const parent = join(process.cwd(), "temp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "build-test-"));
  await build({
    configFile: new URL("vite.config.ts", import.meta.url).pathname,
    logLevel: "silent",
    build: { outDir: directory, emptyOutDir: true },
  });
  return directory;
})();

afterAll(async () => {
  await rm(await temporaryBuild, { recursive: true, force: true });
});

describe("importing on a server", () => {
  // The unit project runs in Node, without a DOM, as a server would.
  it.each(["index.js", "element.js"])(
    "imports %s without touching browser APIs (ADR 0004, ADR 0007)",
    async (entry) => {
      expect(globalThis).not.toHaveProperty("window");
      expect(globalThis).not.toHaveProperty("customElements");
      const url = pathToFileURL(join(await temporaryBuild, entry)).href;
      await expect(import(url)).resolves.toBeTypeOf("object");
    },
  );
});

/**
 * Code generation from strings: `eval(…)`, `new Function(…)` and
 * `Function(…)`, as whole words, so `evaluate(` doesn't match (ADR 0028).
 */
const CODE_GENERATION = /(?<![\w$.])eval\s*\(|(?<![\w$.])(?:new\s+)?Function\s*\(/;

describe("the media worker (docs/adr/0001, docs/adr/0002)", () => {
  const chunkFile = () => {
    const found = files.find((file) => /^lazy\/inline-worker-[\w-]+\.js$/.test(file.fileName));
    if (found?.type !== "chunk") throw new Error("the inlined worker chunk wasn't built");
    return found;
  };

  it("recognises code generation, and nothing that merely looks like it", () => {
    for (const code of ['eval("1")', 'new Function("a", "return a")', "x = Function ('y')"]) {
      expect(code).toMatch(CODE_GENERATION);
    }
    for (const code of ["evaluate(x)", "a.eval(x)", "isFunction(x)"]) {
      expect(code).not.toMatch(CODE_GENERATION);
    }
  });

  it("is inlined in a lazy chunk that only import() loads, never the entries", () => {
    expect(chunkFile().code).toContain("hm-video-media");
    for (const entry of ["index.js", "react.js", "element.js"]) {
      expect(
        chunk(entry).imports.filter((name) => name.startsWith("lazy/")),
        entry,
      ).toEqual([]);
    }
    expect(lazyImports("index.js")).toContain(chunkFile().fileName);
  });

  it("loads the page's audio player lazily, never in the entries (docs/adr/0006)", () => {
    const player = lazyImports("index.js").filter((name) =>
      name.startsWith("lazy/playback-audio-"),
    );
    expect(player).toHaveLength(1);
    // The window scheduler is in it, and only the small lazy wrapper is in the entry.
    expect(chunk(player[0] as string).code).toContain("src/adapters/playback-audio.ts");
    expect(entryCode("index.js")).not.toContain("src/adapters/playback-audio.ts");
    expect(entryCode("index.js")).toContain("src/adapters/lazy-playback-audio.ts");
    // The media worker, the audio player, the export runner and the export worker.
    expect(lazyImports("index.js")).toHaveLength(4);
  });

  it("bundles mediabunny only into the worker, never into the entries", () => {
    expect(workerCode()).toContain("Vanilagy and contributors");
    for (const entry of ["index.js", "react.js", "element.js"]) {
      expect(chunk(entry).code, entry).not.toContain("Vanilagy");
    }
  });

  it("generates no code from strings, in any chunk, including the worker's own source", () => {
    for (const file of files) {
      if (file.type === "chunk") expect(file.code, file.fileName).not.toMatch(CODE_GENERATION);
    }
    expect(workerCode()).not.toMatch(CODE_GENERATION);
  });

  it("can't make requests or start workers: mediabunny's URL source and its own workers are left out", () => {
    // The worker's only inputs are the Blobs the page sends it (ADR 0028).
    const code = workerCode();
    expect(code).not.toMatch(
      /(?<![\w$.])fetch\s*\(|fetchFn|XMLHttpRequest|importScripts|WebSocket|WebTransport|EventSource/,
    );
    expect(code).not.toMatch(/new\s+Worker\s*\(|createObjectURL/);
  });

  it("ships no worker source maps", () => {
    expect(files.filter((file) => /\.worker-[\w-]+\.js\.map$/.test(file.fileName))).toEqual([]);
    expect(workerCode()).not.toMatch(/sourceMappingURL=/);
  });
});

describe("the export worker (docs/adr/0002, docs/adr/0005)", () => {
  const exportChunk = () => {
    const found = files.find((file) =>
      /^lazy\/export-inline-worker-[\w-]+\.js$/.test(file.fileName),
    );
    if (found?.type !== "chunk") throw new Error("the inlined export worker chunk wasn't built");
    return found;
  };

  it("is inlined in its own lazy chunk, loaded with the export runner on the first export", () => {
    expect(exportChunk().code).toContain("hm-video-export");
    const lazy = lazyImports("index.js");
    expect(lazy).toContain(exportChunk().fileName);
    expect(lazy.filter((name) => name.startsWith("lazy/runner-"))).toHaveLength(1);
    expect(entryCode("index.js")).not.toContain("src/adapters/export-worker/export-plan.ts");
  });

  it("bundles mediabunny's muxers, with its licence notice, and can't make requests or start workers", () => {
    const code = workerCode("export-inline-worker");
    expect(code).toMatch(
      /\/\*![\s\S]*?Vanilagy and contributors[\s\S]*?Mozilla Public[\s\S]*?\*\//,
    );
    expect(code).not.toMatch(
      /(?<![\w$.])fetch\s*\(|fetchFn|XMLHttpRequest|importScripts|WebSocket|WebTransport|EventSource/,
    );
    expect(code).not.toMatch(/new\s+Worker\s*\(|createObjectURL/);
    expect(code).not.toMatch(CODE_GENERATION);
    expect(code).not.toMatch(/sourceMappingURL=/);
  });
});

describe("the self-hosted workers (sdk-core ADR 0038)", () => {
  const asset = (fileName: string): string => {
    const found = files.find((file) => file.fileName === fileName);
    if (found?.type !== "asset") throw new Error(`${fileName} wasn't built`);
    return typeof found.source === "string" ? found.source : new TextDecoder().decode(found.source);
  };

  it.each(["assets/video/media.worker.js", "assets/video/export.worker.js"])(
    "writes %s: one minified file, announcing the package's version, with mediabunny's notice",
    async (fileName) => {
      const code = asset(fileName);
      const { version } = JSON.parse(
        await readFile(new URL("package.json", import.meta.url), "utf8"),
      ) as { version: string };
      // As a string literal, in whichever quotes the minifier chose.
      expect(code).toMatch(new RegExp(`["'\`]${version.replaceAll(".", "\\.")}["'\`]`));
      expect(code).toMatch(
        /\/\*![\s\S]*?Vanilagy and contributors[\s\S]*?Mozilla Public[\s\S]*?\*\//,
      );
      // Minified: a self-hosted worker is served as it is.
      expect(code.split("\n").length).toBeLessThan(code.length / 1_000);
      expect(code).not.toMatch(/^import /m);
      expect(code).not.toMatch(
        /(?<![\w$.])fetch\s*\(|fetchFn|XMLHttpRequest|importScripts|WebSocket|WebTransport|EventSource/,
      );
      expect(code).not.toMatch(/new\s+Worker\s*\(|createObjectURL/);
      expect(code).not.toMatch(CODE_GENERATION);
      expect(code).not.toMatch(/sourceMappingURL=/);
    },
  );

  it("writes no other assets", () => {
    expect(
      files
        .filter((file) => file.type === "asset" && file.fileName.startsWith("assets/"))
        .map((file) => file.fileName)
        .sort(),
    ).toEqual(["assets/video/export.worker.js", "assets/video/media.worker.js"]);
  });
});

describe("mediabunny's licence (docs/adr/0001)", () => {
  it("keeps mediabunny's MPL-2.0 notice with its code in the worker", () => {
    expect(workerCode()).toMatch(
      /\/\*![\s\S]*?Vanilagy and contributors[\s\S]*?Mozilla Public[\s\S]*?\*\//,
    );
  });

  it("credits in NOTICE the exact version the lockfile pins, with its source", async () => {
    const lockfile = await readFile(new URL("pnpm-lock.yaml", import.meta.url), "utf8");
    const pinned = /\n {2}mediabunny@(\d+\.\d+\.\d+):/.exec(lockfile)?.[1];
    expect(pinned).toBeDefined();
    const notice = await readFile(new URL("NOTICE", import.meta.url), "utf8");
    expect(notice).toContain(`mediabunny ${pinned}`);
    expect(notice).toContain(`https://github.com/Vanilagy/mediabunny/tree/v${pinned}`);
    expect(notice).toContain("Mozilla Public License, Version 2.0");
  });

  it("ships NOTICE in the package", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", import.meta.url), "utf8"),
    ) as {
      files: string[];
    };
    expect(manifest.files).toContain("NOTICE");
  });
});

/** The media worker's own source, which Vite inlines as a string literal. */
/** The source of an inlined worker, from its lazy chunk: the media worker's by default. */
function workerCode(name = "inline-worker"): string {
  const found = files.find((file) => new RegExp(`^lazy/${name}-[\\w-]+\\.js$`).test(file.fileName));
  if (found?.type !== "chunk") throw new Error(`the inlined ${name} chunk wasn't built`);
  const code = found.code;
  const start = code.indexOf("var jsContent = ") + "var jsContent = ".length;
  let end = start + 1;
  for (let escaped = false; end < code.length; end += 1) {
    const char = code[end];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === code[start]) break;
  }
  return JSON.parse(code.slice(start, end + 1)) as string;
}
