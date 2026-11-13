import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { testAssets, versionDefine } from "./tools/self-hosted-workers.js";

const ALL_BROWSERS = ["chromium", "firefox", "webkit"] as const;

// Browser tests run on Chromium locally, and on all three engines in CI or
// with --mode all-browsers (ADR 0015).
export default defineConfig(({ mode }) => {
  const browsers =
    process.env["CI"] || mode === "all-browsers" ? ALL_BROWSERS : (["chromium"] as const);
  return {
    define: versionDefine(),
    plugins: [testAssets()],
    test: {
      projects: [
        {
          test: {
            name: "unit",
            // build.test.ts checks the built package, so it sits next to the
            // Vite config rather than in src/. test/ holds the repository's
            // own checks, such as the CI image.
            include: ["src/**/*.test.{ts,tsx}", "*.test.ts", "test/**/*.test.ts"],
            exclude: ["**/*.browser.test.{ts,tsx}"],
            environment: "node",
          },
        },
        {
          test: {
            name: "browser",
            // Whether the tests run in the pinned browser image of ci/Dockerfile
            // (ADR 0025 in sdk-core), as in CI and pnpm test:browser:image: the
            // environment the capability matrix describes (docs/capabilities.md).
            // Playwright's image installs its browsers there.
            provide: { browserImage: process.env["PLAYWRIGHT_BROWSERS_PATH"] === "/ms-playwright" },
            include: ["src/**/*.browser.test.{ts,tsx}", "test/**/*.browser.test.ts"],
            browser: {
              enabled: true,
              headless: true,
              provider: playwright(),
              instances: browsers.map((browser) => ({ browser })),
            },
          },
        },
      ],
    },
  };
});

declare module "vitest" {
  export interface ProvidedContext {
    /** Whether the browser tests run in the pinned browser image, as in CI. */
    browserImage: boolean;
  }
}
