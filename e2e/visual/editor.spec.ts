import { applyVisualVariant, visualVariants } from "@hussmartinez/sdk-config/testing/visual";
import { expect, type Page, test } from "@playwright/test";
import { video } from "../targets.js";

/**
 * The editor's designed states, as screenshots (sdk-core ADR 0048). Each is
 * captured in light and dark, compact and comfortable, on the built Vite
 * example as a host renders it, with its workers inlined.
 *
 * | State | What it shows |
 * |---|---|
 * | `empty` | The drop zone, before a video is open |
 * | `open` | Two clips on the timeline, the first frame on the stage, the transport and toolbar |
 * | `selection` | The second clip selected, with its tools enabled |
 * | `paused` | Paused at 1 s, frame 31: the playhead, the stage and the time there |
 * | `export-summary` | The export dialog's summary and choices |
 * | `export-done` | The export dialog's result, with Download focused |
 * | `error` | A file that isn't a video, and the catalogue's text for it |
 *
 * Masks, each with its reason:
 *
 * - `export-done` masks the result line: it names the file's size, which
 *   depends on the browser's encoder, not on the editor's layout.
 *
 * The stage shows a frame of the package's colour-bar test video, decoded by
 * Chromium's VP8 decoder and drawn by the SDK's own worker, which are exact
 * in the pinned image; a paused editor shows no time that varies. The
 * custom element isn't captured: video-sdk doesn't ship one yet.
 */

/** A fixed time, so nothing that reads the clock can vary (ADR 0048). */
const NOW = new Date("2026-11-14T12:00:00Z");
const ORIGIN = "http://localhost:4330";

type State = {
  readonly reach: (page: Page) => Promise<void>;
  /** Regions whose content varies by nature, each with its reason above. */
  readonly mask?: (page: Page) => ReturnType<Page["locator"]>[];
};

/** Opens the test video twice through the drop zone and its picker, as a user would. */
async function opened(page: Page): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files" }).click();
  await (await chooser).setFiles([
    { name: "first.webm", mimeType: "video/webm", buffer: video() },
    { name: "second.webm", mimeType: "video/webm", buffer: video() },
  ]);
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("img", { name: "Video preview, frame 1 of 120" })).toBeVisible();
}

const exportDialog = async (page: Page) => {
  await opened(page);
  await page.getByRole("button", { name: "Export the video", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Export the video" })).toBeVisible();
};

const STATES: Readonly<Record<string, State>> = {
  empty: {
    reach: async (page) => {
      await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
    },
  },
  open: { reach: opened },
  selection: {
    reach: async (page) => {
      await opened(page);
      await page.getByRole("option", { name: /^Clip 2 of 2/ }).click();
      await expect(page.getByRole("option", { name: /^Clip 2 of 2/ })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(
        page.getByRole("button", { name: "Delete the selected clips" }),
      ).not.toHaveAttribute("aria-disabled");
    },
  },
  paused: {
    reach: async (page) => {
      await opened(page);
      // A second on, from the playhead's own keys.
      await page.getByRole("slider", { name: "Playhead" }).focus();
      await page.keyboard.press("PageUp");
      await expect(page.getByRole("slider", { name: "Playhead" })).toHaveAttribute(
        "aria-valuetext",
        "0:01.00",
      );
      await expect(page.getByRole("img", { name: "Video preview, frame 31 of 120" })).toBeVisible();
      await page.getByRole("slider", { name: "Playhead" }).blur();
    },
  },
  "export-summary": { reach: exportDialog },
  "export-done": {
    reach: async (page) => {
      await exportDialog(page);
      const dialog = page.getByRole("dialog", { name: "Export the video" });
      await dialog.getByRole("button", { name: "Export", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Download" })).toBeFocused({
        timeout: 60_000,
      });
    },
    mask: (page) => [page.locator(".hm-video-export-result")],
  },
  error: {
    reach: async (page) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Choose files" }).click();
      await (await chooser).setFiles({
        name: "notes.webm",
        mimeType: "video/webm",
        buffer: Buffer.from("not a video at all"),
      });
      // The stage's alert, not the announcer's empty assertive region.
      await expect(page.locator(".hm-video-stage-error")).toBeVisible();
    },
  },
};

for (const [state, { reach, mask }] of Object.entries(STATES)) {
  for (const variant of visualVariants) {
    test(`${state}, ${variant.name}`, async ({ page }) => {
      // No request may leave the page's origin (sdk-core ADR 0012).
      const foreign: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) return;
        if (url.origin !== ORIGIN) foreign.push(request.url());
      });
      await page.clock.install({ time: NOW });
      await page.goto("/inline.html");
      await applyVisualVariant(page, variant);
      await reach(page);
      // The pointer rests outside the editor, so no hover styles show.
      await page.mouse.move(0, 0);
      await expect(page).toHaveScreenshot(`${state}-${variant.name}.png`, {
        ...(mask ? { mask: mask(page) } : {}),
      });
      expect(foreign).toEqual([]);
    });
  }
}
