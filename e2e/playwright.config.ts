import { webServersFor } from "@hussmartinez/sdk-config/testing/require-image";
import { endToEndTimeouts } from "@hussmartinez/sdk-config/testing/timeouts";
import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env["CI"]);

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
  // The family's timeouts (sdk-core ADR 0057): 60 s a test, 10 s an assertion
  // that waits. The slowest test, the export's, measured 7.8 s in WebKit.
  ...endToEndTimeouts,
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
  // Outside the image none starts, so the guard's message comes first: Playwright
  // starts the web servers before the global setup (sdk-config's webServersFor).
  webServer: webServersFor([
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
  ]),
});
