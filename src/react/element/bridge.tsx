import { type ReactNode, useContext, useEffect, useRef } from "react";
import type { VideoError } from "../../core/errors/video-error.js";
import type { VideoPlan } from "../../core/model/plan.js";
import { useVideoOutput, useVideoSession } from "../context.js";
import { ElementListenersContext } from "./listeners.js";

/**
 * Tells the element what it fires (docs/adr/0007): the plan after each
 * change, and each failure the editor shows, the session's or playback's,
 * once. Inside an editor with no element around it, there are no listeners
 * and it does nothing. It renders nothing either way.
 *
 * @internal
 */
export function ElementBridge(): ReactNode {
  const { onChange, onError } = useContext(ElementListenersContext);
  const { snapshot } = useVideoSession();
  const { snapshot: playback } = useVideoOutput();

  // The plan after each insert, edit, undo or redo; not before the first file.
  const plan = useRef<VideoPlan | null>(null);
  useEffect(() => {
    if (!onChange || snapshot.plan === null || snapshot.plan === plan.current) return;
    plan.current = snapshot.plan;
    onChange(snapshot.plan);
  }, [snapshot.plan, onChange]);

  // Each failure once, with its code and details: never a file name, which
  // no code or detail carries (sdk-core ADR 0012).
  const reported = useRef(new WeakSet<VideoError>());
  const failures = [snapshot.error, playback?.error ?? null];
  useEffect(() => {
    if (!onError) return;
    for (const failure of failures) {
      if (!failure || reported.current.has(failure)) continue;
      reported.current.add(failure);
      onError({ code: failure.code, details: { ...(failure.details ?? {}) } });
    }
  });

  return null;
}
