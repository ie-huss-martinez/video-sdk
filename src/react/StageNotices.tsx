import { CloseIcon, IconButton, useAnnounce } from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { VideoWarning } from "../core/model/warnings.js";
import { videoWarningText } from "../messages/text.js";
import { useVideoEditor, useVideoSession } from "./context.js";

/** A warning's identity: its kind, its limit and its source, so a dismissal holds for that one. */
function warningKey(warning: VideoWarning): string {
  return warning.type === "limit"
    ? `limit:${warning.limit}:${warning.source ?? ""}`
    : `${warning.type}:${warning.source}`;
}

/**
 * The session's warnings, in the stage's notice area at its foot: a large or
 * long video, one whose sound couldn't be decoded, a large session. Each can
 * be dismissed, and doesn't come back for the same source and limit, as
 * audio-sdk's notices don't. A warning that appears is announced politely
 * once, since it follows an insert or an edit that otherwise succeeded.
 */
export function StageNotices(): ReactNode {
  const { messages } = useVideoEditor();
  const { snapshot } = useVideoSession();
  const announce = useAnnounce();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const items = snapshot.warnings
    .map((warning) => ({ key: warningKey(warning), text: videoWarningText(messages, warning) }))
    .filter((item) => !dismissed.has(item.key));

  // Announced once each, when it first appears: not again on a re-render,
  // nor when an undo and a redo bring it back.
  const announced = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh = items.filter((item) => !announced.current.has(item.key));
    if (fresh.length === 0) return;
    announced.current = new Set([...announced.current, ...fresh.map((item) => item.key)]);
    announce(fresh.map((item) => item.text).join(" "));
  });

  if (items.length === 0) return null;
  return (
    <section className="hm-video-stage-notices" aria-label={messages.t("stage.notices")}>
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <p>{item.text}</p>
            <IconButton
              variant="quiet"
              size="small"
              label={messages.t("stage.dismiss")}
              icon={<CloseIcon />}
              onClick={() => setDismissed((keys) => new Set([...keys, item.key]))}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
