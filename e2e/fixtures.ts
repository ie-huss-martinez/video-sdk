import { withFirefoxLabelledByGuard } from "@hussmartinez/sdk-config/testing/firefox-labelled-by";
import { test as base } from "@playwright/test";

/**
 * Playwright's `test`, with the family's guard against Playwright's Firefox
 * 159 crashing a page whose `ariaLabelledByElements` two JavaScript worlds
 * read (ui#61): locators by role or name read it in one, and axe in the
 * other, as these tests do. The guard removes the property in Firefox only,
 * before any script runs; axe then resolves `aria-labelledby` by ID.
 */
export const test = withFirefoxLabelledByGuard(base);
export { expect } from "@playwright/test";
