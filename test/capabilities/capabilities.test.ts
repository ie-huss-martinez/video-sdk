import { expect, it } from "vitest";
import { renderCapabilities } from "./matrix.js";

it("keeps docs/capabilities.md rendered from the matrix", async () => {
  await expect(renderCapabilities()).toMatchFileSnapshot("../../docs/capabilities.md");
});
