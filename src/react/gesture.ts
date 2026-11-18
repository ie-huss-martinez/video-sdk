import { type RefCallback, useCallback, useEffect, useRef, useState } from "react";

/** How long after the last key a run of keys on a slider is committed, in milliseconds. */
export const KEY_RUN = 400;

/**
 * A slider's value while a gesture changes it, committed once when the
 * gesture ends, so a drag or a run of arrow keys is one undo step
 * (sdk-core ADR 0010: a gesture that spans events records one step when it
 * ends).
 *
 * - **A drag** commits when the pointer lets go, which is when the browser
 *   fires the input's `change` event.
 * - **A run of keys** commits {@link KEY_RUN} ms after the last one, or when
 *   focus leaves.
 * - **Unmounting** commits what's pending, so a change is never lost.
 *
 * @param committed - The value the document has.
 * @param commit - Called once with the gesture's last value, when it differs.
 * @param end - Called when a gesture ends, after `commit`, whether or not
 * the value changed: where a preview of the gesture is dropped.
 * @returns The value to show, `change` for the slider's `onValueChange`, and
 * `ref` for the slider's input.
 * @internal
 */
export function useGestureValue(
  committed: number,
  commit: (value: number) => void,
  end?: () => void,
): {
  readonly value: number;
  readonly change: (value: number) => void;
  readonly ref: RefCallback<HTMLInputElement>;
} {
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const pressed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ committed, commit, end });
  latest.current = { committed, commit, end };

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const value = pending.current;
    pending.current = null;
    setDraft(null);
    if (value !== null && value !== latest.current.committed) latest.current.commit(value);
    if (value !== null) latest.current.end?.();
  }, []);

  const change = useCallback(
    (value: number) => {
      pending.current = value;
      setDraft(value);
      clearTimeout(timer.current);
      // A drag is committed by the input's change event; keys, by a pause.
      if (!pressed.current) timer.current = setTimeout(flush, KEY_RUN);
    },
    [flush],
  );

  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback<RefCallback<HTMLInputElement>>(
    (input) => {
      cleanup.current?.();
      cleanup.current = null;
      if (!input) return;
      const down = () => {
        pressed.current = true;
      };
      // Letting go ends the drag. The change event usually follows and
      // commits; where the pointer was let go without one, this does.
      const up = () => {
        pressed.current = false;
        if (pending.current !== null) {
          clearTimeout(timer.current);
          timer.current = setTimeout(flush, 0);
        }
      };
      // The native event: React's onChange is the input event, on every move.
      const changed = () => {
        if (pressed.current) {
          pressed.current = false;
          flush();
        }
      };
      input.addEventListener("pointerdown", down);
      input.addEventListener("pointerup", up);
      input.addEventListener("pointercancel", up);
      input.addEventListener("change", changed);
      input.addEventListener("blur", flush);
      cleanup.current = () => {
        input.removeEventListener("pointerdown", down);
        input.removeEventListener("pointerup", up);
        input.removeEventListener("pointercancel", up);
        input.removeEventListener("change", changed);
        input.removeEventListener("blur", flush);
      };
    },
    [flush],
  );

  // What's pending when the control goes is still committed.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      const value = pending.current;
      pending.current = null;
      if (value !== null && value !== latest.current.committed) latest.current.commit(value);
      if (value !== null) latest.current.end?.();
    },
    [],
  );

  return { value: draft ?? committed, change, ref };
}
