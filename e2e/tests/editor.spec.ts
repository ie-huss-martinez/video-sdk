import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { targets, video, WORKER_PATHS } from "../targets.js";

/**
 * The editor on each built example, as a host serves it (docs/adr/0007 in
 * the package; sdk-core ADR 0007, ADR 0012): rendered on the server where
 * the framework does, hydrated without a warning, and used afterwards, with
 * its workers inlined or self-hosted under the Content Security Policy each
 * needs: opening a file, playing it and exporting it, with no violation, no
 * error, and no request to another origin.
 */
interface Problems {
  console: string[];
  errors: string[];
  foreignRequests: string[];
  requests: string[];
}

function watch(page: Page, origin: string): Problems {
  const problems: Problems = { console: [], errors: [], foreignRequests: [], requests: [] };
  page.on("console", (message) => {
    // A Content Security Policy violation is reported here in every engine.
    if (message.type() === "error" || message.type() === "warning") {
      problems.console.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.errors.push(error.message));
  const record = (url: string) => {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith("http")) return;
    if (parsed.origin === origin) problems.requests.push(parsed.pathname);
    else problems.foreignRequests.push(url);
  };
  page.on("request", (request) => record(request.url()));
  // Requests a worker makes, which the page's own event doesn't see.
  page.on("worker", (worker) => record(worker.url()));
  return problems;
}

/** Waits for animations to settle, so axe checks colours as they end, not mid-fade. */
async function noViolations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page }).include(".hm-video-editor").analyze();
  const found = results.violations.map(
    (v) =>
      `${v.id}: ${v.help} at ${v.nodes.map((n) => `${n.target.join(" ")} (${n.failureSummary ?? ""})`).join("; ")}`,
  );
  expect(found).toEqual([]);
}

/** Opens the test video through the drop zone's button, as a user would. */
async function open(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles({
    name: "landscape.webm",
    mimeType: "video/webm",
    buffer: video(),
  });
  await expect(page.getByRole("img", { name: "Video preview, frame 1 of 60" })).toBeVisible();
}

test.describe("the Next.js example's server rendering", () => {
  for (const target of targets.filter((each) => each.url.includes(":4331"))) {
    test(`renders the empty editor on the server, with no canvas: ${target.name}`, async ({
      request,
    }) => {
      const response = await request.get(target.url);
      expect(response.ok()).toBe(true);
      const html = await response.text();
      expect(html).toContain('aria-label="Video editor"');
      expect(html).toContain("hm-video-stage-drop");
      expect(html).not.toContain("<canvas");
      // The policy each page needs, with a nonce for Next.js's scripts.
      const policy = response.headers()["content-security-policy"] ?? "";
      expect(policy).toContain(target.selfHosted ? "worker-src 'self'" : "worker-src blob:");
      expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    });
  }
});

for (const target of targets) {
  test.describe(target.name, () => {
    test("opens, plays and exports a video, with no violation, error or foreign request", async ({
      page,
    }) => {
      const origin = new URL(target.url).origin;
      const problems = watch(page, origin);
      await page.goto(target.url);
      await open(page);

      // Plays: the time moves on from the start.
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(page.locator(".hm-video-transport-time")).not.toHaveText(/^0:00\.00 /);
      await page.getByRole("button", { name: "Pause", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

      // Exports, in its own worker, to a file ready to download.
      await page.getByRole("button", { name: "Export the video", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Export the video" });
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Download" })).toBeFocused({
        timeout: 90_000,
      });
      await expect(dialog).toContainText(/video is ready/);

      // The workers came from where this page's policy allows them.
      for (const path of WORKER_PATHS) {
        expect(problems.requests.includes(path), path).toBe(target.selfHosted);
      }
      expect(problems.errors).toEqual([]);
      expect(problems.console).toEqual([]);
      expect(problems.foreignRequests).toEqual([]);
    });

    test("has no accessibility violations, empty, with a video open and with a clip selected", async ({
      page,
    }) => {
      await page.goto(target.url);
      await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
      await noViolations(page);
      await open(page);
      await noViolations(page);
      // The inspector's controls for the selected clip.
      await page.getByRole("option", { name: /^Clip 1 of 1/ }).click();
      await expect(page.getByRole("slider", { name: "Volume" })).toBeVisible();
      await noViolations(page);
    });

    test("changes the selected clip's sound from the inspector, by keyboard, under the page's policy", async ({
      page,
    }) => {
      const origin = new URL(target.url).origin;
      const problems = watch(page, origin);
      await page.goto(target.url);
      await open(page);
      // Select the clip with the timeline's own keys: selection follows focus.
      await page.getByRole("option", { name: /^Clip 1 of 1/ }).focus();
      await page.keyboard.press("Home");
      await expect(page.getByRole("option", { name: /^Clip 1 of 1/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const inspector = page.getByRole("region", { name: "Inspector" });
      await expect(
        inspector.getByRole("group", { name: "Sound of the selected clip" }),
      ).toBeVisible();

      // Volume, from the slider's keys: shown at once, and one undo step.
      const volume = inspector.getByRole("slider", { name: "Volume" });
      await volume.focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowLeft");
      await expect(volume).toHaveAttribute("aria-valuetext", "-2 dB");
      const exact = inspector.getByRole("spinbutton", { name: "Volume in decibels" });
      await expect(exact).toHaveValue("-2");

      // Mute, by its key from anywhere in the editor, shows on the button and the clip.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(inspector.getByRole("button", { name: "Mute" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(inspector.getByRole("button", { name: "Mute" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByRole("option", { name: /, muted$/ })).toBeVisible();

      // A fade in of half a second, smoothly.
      const fadeIn = inspector.getByRole("spinbutton", { name: "Fade in, in seconds" });
      await fadeIn.fill("0.5");
      await page.keyboard.press("Enter");
      await expect(fadeIn).toHaveValue("0.5");
      await inspector
        .getByRole("radiogroup", { name: "Fade in shape" })
        .getByRole("radio", { name: "Smooth" })
        .click();
      await expect(
        inspector.getByRole("radiogroup", { name: "Fade in shape" }).getByRole("radio", {
          name: "Smooth",
        }),
      ).toBeChecked();

      // Undo takes each back, a step at a time: the shape, the fade, the mute, the volume.
      const undo = page.getByRole("button", { name: /^Undo/ });
      for (let step = 0; step < 3; step += 1) await undo.click();
      await expect(volume).toHaveAttribute("aria-valuetext", "-2 dB");
      await expect(fadeIn).toHaveValue("0");
      await undo.click();
      await expect(volume).toHaveAttribute("aria-valuetext", "0 dB");

      expect(problems.errors).toEqual([]);
      expect(problems.console).toEqual([]);
      expect(problems.foreignRequests).toEqual([]);
    });
  });
}
