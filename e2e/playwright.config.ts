import { browserTestImageProblem } from "@hussmartinez/sdk-config/testing/require-image";
import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env["CI"]);
// Playwright starts the web servers before the global setup, so outside the
// image none starts: the guard's explanation comes first, not a server's
// failure. Inside the image and in CI, nothing changes.
const outsideImage = browserTestImageProblem(process.env) !== undefined;

/**
 * End-to-end tests against production builds of the Vite and Next.js
 * examples (sdk-core ADR 0007, ADR 0039): server rendering, hydration, the
 * editor under each Content Security Policy, axe, and no request to another
 * origin (ADR 0012 in sdk-core). Chromium locally, all three engines in CI,
 * as for the other browser tests.
 */
export default defineConfig({
  testDir: "tests",
  // Refuses to start a browser on the host, as the browser tests do: through
  // hm-in-image only (sdk-core ADR 0049). The visual config has its own runner.
  globalSetup: "@hussmartinez/sdk-config/testing/require-image",
  forbidOnly: ci,
  retries: 0,
  reporter: ci ? "line" : "list",
  // Real decoding and export in workers: room for a loaded machine.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { trace: "retain-on-failure" },
  projects: (
    [
      ["chromium", "Desktop Chrome"],
      ["firefox", "Desktop Firefox"],
      ["webkit", "Desktop Safari"],
    ] as const
  )
    .filter(([name]) => ci || name === "chromium")
    .map(([name, device]) => ({ name, use: { ...devices[device] } })),
  // Started with Node directly, so the suite also runs in the pinned browser
  // image, which has no pnpm.
  webServer: outsideImage
    ? []
    : [
        {
          command: "node node_modules/vite/bin/vite.js preview --port 4330 --strictPort",
          cwd: "../examples/vite",
          url: "http://localhost:4330",
          reuseExistingServer: !ci,
          timeout: 60_000,
        },
        {
          command: "node node_modules/next/dist/bin/next start --port 4331",
          cwd: "../examples/next",
          url: "http://localhost:4331",
          reuseExistingServer: !ci,
          timeout: 60_000,
          env: { NEXT_TELEMETRY_DISABLED: "1" },
        },
      ],
});
