import { CloseIcon, IconButton, useAnnounce } from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { videoWarningText } from "../messages/text.js";
import { useVideoEditor, useVideoSession } from "./context.js";

/**
 * The session's warnings, in the stage's notice area at its foot: a large or
 * long video, one whose sound couldn't be decoded, a large session. Each can
 * be dismissed, and that kind doesn't come back. A kind that appears is
 * announced politely once, since it follows an insert or an edit that
 * otherwise succeeded.
 * `hidden` hides them while the stage is empty, keeping what was dismissed
 * and announced.
 */
export function StageNotices({ hidden }: { readonly hidden: boolean }): ReactNode {
  const { messages } = useVideoEditor();
  const { snapshot } = useVideoSession();
  const announce = useAnnounce();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  // One notice per kind of warning, which is also what a dismissal hides: a
  // file that's long and the video it makes are two warnings of one kind,
  // with the same words, and the same words twice would only be noise. A
  // kind's text can carry a value, such as the memory in use, so keying by
  // text would bring a dismissed notice back whenever that value changed.
  const kinds = new Map<string, Set<string>>();
  for (const warning of snapshot.warnings) {
    const kind = warning.type === "limit" ? `limit:${warning.limit}` : warning.type;
    const texts = kinds.get(kind) ?? new Set<string>();
    texts.add(videoWarningText(messages, warning));
    kinds.set(kind, texts);
  }
  const items = [...kinds]
    .map(([key, texts]) => ({ key, text: [...texts].join(" ") }))
    .filter((item) => !dismissed.has(item.key));

  // Announced once each, when it first appears: not again on a re-render,
  // nor when an undo and a redo bring it back.
  const announced = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (hidden) return;
    const fresh = items.filter((item) => !announced.current.has(item.key));
    if (fresh.length === 0) return;
    announced.current = new Set([...announced.current, ...fresh.map((item) => item.key)]);
    announce(fresh.map((item) => item.text).join(" "));
  });

  if (hidden || items.length === 0) return null;
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
