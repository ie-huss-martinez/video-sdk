import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VideoEditor } from "./VideoEditor.js";

// The editor rendered on a server, in Node, where there's no page to resolve
// a relative URL against (sdk-core ADR 0007): as Next.js renders it.
describe("the editor on a server", () => {
  it("renders with self-hosted workers at a path relative to the page", () => {
    const html = renderToString(<VideoEditor assetsUrl="/video-sdk/" />);
    expect(html).toContain('aria-label="Video editor"');
    expect(html).not.toContain("<canvas");
  });
});
