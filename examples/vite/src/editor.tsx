import "@hussmartinez/ui/styles.css";
import "@hussmartinez/video-sdk/styles.css";
import "./example.css";
import { VideoEditor } from "@hussmartinez/video-sdk/react";
import { createRoot } from "react-dom/client";

/**
 * The editor, as a host renders it: ui's stylesheet first, then the SDK's
 * (sdk-core ADR 0036). The self-hosted page names where it serves the
 * package's assets; the inline page starts the workers from blob: URLs.
 */
const element = document.querySelector<HTMLElement>("#editor");
if (element) {
  const assetsUrl = element.dataset["assetsUrl"];
  createRoot(element).render(
    <div className="example-frame">
      <VideoEditor {...(assetsUrl ? { assetsUrl } : {})} />
    </div>,
  );
}
