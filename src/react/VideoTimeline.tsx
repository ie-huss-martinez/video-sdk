import { platformOf, snap } from "@hussmartinez/sdk-core";
import {
  Field,
  IconButton,
  Slider,
  SnapIcon,
  ToggleButton,
  Toolbar,
  TrimEndIcon,
  TrimStartIcon,
} from "@hussmartinez/ui/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { frameTime } from "../core/model/time.js";
import type { VideoCommand } from "../core/operations/commands.js";
import { useVideoEditor, useVideoOutput, useVideoPlayhead, useVideoSession } from "./context.js";
import { formatTimecode } from "./timecode.js";
import {
  type ClipEdge,
  edgeLimits,
  moveTarget,
  offsetsOf,
  selectRange,
  type TrimRange,
  trimEdge,
  trimToPlayhead,
} from "./timeline-model.js";

/**
 * Props of {@link VideoTimeline}.
 *
 * @public
 */
export interface VideoTimelineProps {
  readonly className?: string;
}

/** The closest zoom, in CSS pixels per output frame. */
const MAX_PIXELS_PER_FRAME = 48;
/** The snapping distance, in CSS pixels (docs/adr/0007). */
const SNAP_PIXELS = 8;

/** Whether an element lays out right to left. */
function rtl(element: Element): boolean {
  return getComputedStyle(element).direction === "rtl";
}

/** Captures a pointer, if it's still down: it may be up already. */
function capture(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // NotFoundError: the pointer isn't active; its events still arrive here.
  }
}

/** A trim being dragged: the clip, its edge and the frames it has moved so far. */
interface EdgeDrag {
  readonly index: number;
  readonly edge: ClipEdge;
  readonly delta: number;
}

/**
 * The timeline (docs/adr/0007): the plan's clips on one track, as a
 * horizontal listbox with roving focus, the playhead as a slider, and
 * buttons to snap and trim. Its zoom is the editor's, which the zoom tools
 * set.
 *
 * Every drag has a keyboard alternative, and a single-pointer one: a clip's
 * edges trim by dragging, by `[` and `]` to the playhead, by `Alt+[` and
 * `Alt+]` one frame inward (with `Shift`, outward), and by the trim buttons.
 * `Alt+Left` and `Alt+Right` move the selected clips past their neighbour.
 * The keys it handles are marked handled, so the editor's shortcuts skip
 * them.
 *
 * @public
 */
export function VideoTimeline(props: VideoTimelineProps): ReactNode {
  const { messages, locale, selectedClips, setSelectedClips, zoom, setMaxZoom } = useVideoEditor();
  const { session, snapshot } = useVideoSession();
  const { output, snapshot: playback } = useVideoOutput();
  const playhead = useVideoPlayhead();
  const plan = snapshot.plan;
  const clips = plan?.clips ?? [];
  const rate = plan?.output.frameRate ?? { num: 30, den: 1 };
  const offsets = useMemo(() => (plan ? offsetsOf(plan) : [0]), [plan]);
  const frames = offsets[offsets.length - 1] ?? 0;
  const playing = playback?.state === "playing";

  const region = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const options = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(0);
  const [snapping, setSnapping] = useState(true);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<EdgeDrag | null>(null);
  const anchor = useRef<string | null>(null);
  const hadFocus = useRef(false);
  const knownKeys = useRef<readonly string[] | null>(null);

  const fit = frames > 0 && width > 0 ? width / frames : 1;
  // The editor's zoom is a multiple of fitting the plan to the track.
  const pixelsPerFrame = Math.min(Math.max(fit, fit * zoom), Math.max(fit, MAX_PIXELS_PER_FRAME));
  const tolerance = Math.round(SNAP_PIXELS / pixelsPerFrame);
  const focusIndex = Math.max(
    0,
    clips.findIndex((clip) => clip.key === focusKey),
  );
  const focused = clips[focusIndex];

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // Whether focus is in the editor: in its root, or lost from it, as when the
  // drop zone that had it goes away once a file is in.
  useEffect(() => {
    const root = region.current?.closest(".hm-video-editor") ?? region.current;
    if (!root) return;
    hadFocus.current = root.contains(document.activeElement);
    const onIn = () => {
      hadFocus.current = true;
    };
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !root.contains(next)) hadFocus.current = false;
    };
    root.addEventListener("focusin", onIn);
    root.addEventListener("focusout", onOut as EventListener);
    return () => {
      root.removeEventListener("focusin", onIn);
      root.removeEventListener("focusout", onOut as EventListener);
    };
  }, []);

  // Keep the selection to clips that exist, and move focus (docs/adr/0007)
  // when the editor had focus, so an insert by the host on load doesn't take
  // it: to a new clip, such as a split's second part, an insert or a clip an
  // undo restored; or, when the focused clip goes, to the one that took its
  // place, or else the one before.
  useEffect(() => {
    const keys = new Set(clips.map((clip) => clip.key));
    const before = knownKeys.current;
    knownKeys.current = clips.map((clip) => clip.key);
    if (selectedClips.some((key) => !keys.has(key))) {
      setSelectedClips(selectedClips.filter((key) => keys.has(key)));
    }
    const moveFocus = (key: string) => {
      setFocusKey(key);
      setSelectedClips([key]);
      anchor.current = key;
      // The option renders with this commit; focus it after.
      requestAnimationFrame(() => options.current.get(key)?.focus());
    };
    const added = before ? clips.find((clip) => !before.includes(clip.key)) : undefined;
    if (added && hadFocus.current) {
      moveFocus(added.key);
    } else if (focusKey !== null && !keys.has(focusKey)) {
      const was = before?.indexOf(focusKey) ?? -1;
      const next = clips[Math.min(Math.max(was, 0), clips.length - 1)];
      if (next && hadFocus.current) moveFocus(next.key);
      else setFocusKey(null);
    }
  }, [clips, selectedClips, setSelectedClips, focusKey]);

  // While playing, keep the playhead in view.
  useEffect(() => {
    const element = scroller.current;
    if (!playing || !element) return;
    const x = playhead * pixelsPerFrame;
    if (x < element.scrollLeft || x > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = Math.max(0, x - element.clientWidth / 10);
    }
  }, [playing, playhead, pixelsPerFrame]);

  const timecode = (frame: number) => formatTimecode(frameTime(frame, rate), locale);

  const execute = (command: VideoCommand) => {
    try {
      session.execute(command);
    } catch {
      // The session's snapshot holds the error, which the stage shows.
    }
  };

  const trim = (key: string, range: TrimRange | undefined) => {
    if (range) execute({ type: "video.trimClip", key, start: range.start, end: range.end });
  };

  const focusClip = (key: string | undefined) => {
    if (key === undefined) return;
    setFocusKey(key);
    options.current.get(key)?.focus();
  };

  const select = (key: string, how: { readonly extend: boolean; readonly toggle: boolean }) => {
    if (!plan) return;
    if (how.extend) {
      const from = clips.findIndex((clip) => clip.key === (anchor.current ?? key));
      const to = clips.findIndex((clip) => clip.key === key);
      setSelectedClips(selectRange(plan, Math.max(0, from), to));
      return;
    }
    anchor.current = key;
    if (how.toggle) {
      setSelectedClips(
        selectedClips.includes(key)
          ? selectedClips.filter((each) => each !== key)
          : clips
              .map((clip) => clip.key)
              .filter((each) => each === key || selectedClips.includes(each)),
      );
    } else {
      setSelectedClips([key]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!plan || !focused) return;
    const apple = platformOf(typeof navigator === "undefined" ? undefined : navigator) === "apple";
    const mod = apple ? event.metaKey : event.ctrlKey;
    const handled = () => event.preventDefault();
    const go = (index: number) => {
      const key = clips[Math.min(Math.max(index, 0), clips.length - 1)]?.key;
      if (key === undefined) return;
      focusClip(key);
      if (!mod) select(key, { extend: event.shiftKey, toggle: false });
    };

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        // In a right-to-left layout, time runs leftward.
        const forward = event.key === "ArrowRight" ? 1 : -1;
        const direction = (rtl(event.currentTarget) ? -forward : forward) as -1 | 1;
        handled();
        if (event.altKey) {
          const keys = selectedClips.includes(focused.key) ? selectedClips : [focused.key];
          const to = moveTarget(plan, keys, direction);
          if (to !== undefined) execute({ type: "video.moveClips", keys, to });
          // Focus stays on the clip, wherever it moved.
          requestAnimationFrame(() => options.current.get(focused.key)?.focus());
        } else {
          go(focusIndex + direction);
        }
        return;
      }
      case "Home":
      case "End":
        handled();
        go(event.key === "Home" ? 0 : clips.length - 1);
        return;
      case " ":
        // A listbox's own key (sdk-core ADR 0030 leaves Space to options):
        // it toggles the focused clip, and with Shift selects up to it.
        handled();
        select(focused.key, { extend: event.shiftKey, toggle: !event.shiftKey });
        return;
      case "a":
      case "A":
        if (!mod || event.altKey) return;
        handled();
        setSelectedClips(clips.map((clip) => clip.key));
        return;
    }
    // The bracket keys by position, as Alt changes the character they type.
    if ((event.code === "BracketLeft" || event.code === "BracketRight") && !mod) {
      const edge: ClipEdge = event.code === "BracketLeft" ? "start" : "end";
      handled();
      trim(
        focused.key,
        event.altKey
          ? trimEdge(plan, focusIndex, edge, event.shiftKey ? 1 : -1)
          : trimToPlayhead(plan, focusIndex, playhead, edge),
      );
    }
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const key = (event.target as Element)
      .closest<HTMLElement>("[data-hm-key]")
      ?.getAttribute("data-hm-key");
    if (key == null) return;
    const apple = platformOf(navigator) === "apple";
    setFocusKey(key);
    select(key, { extend: event.shiftKey, toggle: apple ? event.metaKey : event.ctrlKey });
  };

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>, track: HTMLElement) => {
    if (!output || frames === 0) return;
    const box = track.getBoundingClientRect();
    const x = rtl(track) ? box.right - event.clientX : event.clientX - box.left;
    const raw = Math.floor(x / pixelsPerFrame);
    const frame = Math.min(Math.max(raw, 0), frames - 1);
    const snapped = snapping && !event.altKey ? snap(frame, offsets, tolerance) : frame;
    output.seek(Math.min(snapped, frames - 1));
  };

  const onTrackPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Clips select on click; the space around them seeks.
    if (event.button !== 0 || (event.target as Element).closest('[role="option"]')) return;
    const track = event.currentTarget;
    capture(track, event.pointerId);
    seekFromPointer(event, track);
  };

  const onTrackPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const track = event.currentTarget;
    if (drag === null && track.hasPointerCapture(event.pointerId)) seekFromPointer(event, track);
  };

  const startDrag = (event: PointerEvent<HTMLElement>, index: number, edge: ClipEdge) => {
    if (event.button !== 0 || !plan) return;
    event.preventDefault();
    event.stopPropagation();
    const clip = plan.clips[index];
    const source = snapshot.sources.find((each) => each.id === clip?.source);
    if (!clip || !source) return;
    const limits = edgeLimits(plan, index, edge, source.duration);
    const origin = event.clientX;
    const sign = rtl(event.currentTarget) ? -1 : 1;
    const boundary = edge === "start" ? (offsets[index] ?? 0) : (offsets[index + 1] ?? 0);
    const targets = [...offsets.filter((each) => each !== boundary), playhead];
    const handle = event.currentTarget;
    capture(handle, event.pointerId);
    let delta = 0;
    const move = (moved: globalThis.PointerEvent) => {
      const position = Math.max(
        0,
        boundary + Math.round((sign * (moved.clientX - origin)) / pixelsPerFrame),
      );
      const at = snapping && !moved.altKey ? snap(position, targets, tolerance) : position;
      const raw = edge === "start" ? boundary - at : at - boundary;
      delta = Math.min(Math.max(raw, limits.min), limits.max);
      setDrag({ index, edge, delta });
    };
    const end = (ended: globalThis.PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDrag(null);
      if (ended.type === "pointerup" && delta !== 0)
        trim(clip.key, trimEdge(plan, index, edge, delta));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  // The zoom tools stop where a frame is MAX_PIXELS_PER_FRAME wide.
  useEffect(() => {
    setMaxZoom(Math.max(1, MAX_PIXELS_PER_FRAME / fit));
  }, [fit, setMaxZoom]);

  // After a zoom, bring the playhead back into view; not as it moves, or as
  // the width changes.
  const view = useRef({ playhead, pixelsPerFrame });
  view.current = { playhead, pixelsPerFrame };
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || zoom <= 1) return;
    const { playhead: at, pixelsPerFrame: scale } = view.current;
    element.scrollLeft = Math.max(0, at * scale - element.clientWidth / 2);
  }, [zoom]);

  const empty = !plan || frames === 0;
  const startTrim =
    plan && focused ? trimToPlayhead(plan, focusIndex, playhead, "start") : undefined;
  const endTrim = plan && focused ? trimToPlayhead(plan, focusIndex, playhead, "end") : undefined;

  return (
    <section
      className={["hm-video-timeline", props.className].filter(Boolean).join(" ")}
      aria-label={messages.t("timeline.label")}
      ref={region}
    >
      <Toolbar className="hm-video-timeline-tools" label={messages.t("timeline.tools")}>
        <IconButton
          label={messages.t("timeline.trimStart")}
          icon={<TrimStartIcon />}
          disabled={!startTrim}
          onClick={() => focused && trim(focused.key, startTrim)}
        />
        <IconButton
          label={messages.t("timeline.trimEnd")}
          icon={<TrimEndIcon />}
          disabled={!endTrim}
          onClick={() => focused && trim(focused.key, endTrim)}
        />
        <ToggleButton
          label={messages.t("timeline.snap")}
          icon={<SnapIcon />}
          pressed={snapping}
          onPressedChange={setSnapping}
        />
      </Toolbar>
      {/* The Field shows the slider's name, and labels it (WCAG 2.5.3). */}
      <Field label={messages.t("timeline.playhead")} className="hm-video-timeline-playhead">
        <Slider
          min={0}
          max={Math.max(0, frames - 1)}
          step={1}
          largeStep={Math.max(1, Math.round(rate.num / rate.den))}
          value={Math.min(playhead, Math.max(0, frames - 1))}
          formatValue={timecode}
          disabled={empty || !output}
          onValueChange={(frame) => output?.seek(frame)}
        />
      </Field>
      <div className="hm-video-timeline-scroll" ref={scroller}>
        {empty ? null : (
          <div
            className="hm-video-timeline-track"
            style={{ inlineSize: `${frames * pixelsPerFrame}px` }}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
          >
            <div
              className="hm-video-timeline-clips"
              role="listbox"
              aria-label={messages.t("timeline.clips")}
              aria-orientation="horizontal"
              aria-multiselectable="true"
              onKeyDown={onKeyDown}
              onClick={onClick}
            >
              {clips.map((clip, index) => {
                const start = offsets[index] ?? 0;
                const length = (offsets[index + 1] ?? start) - start;
                const dragged = drag?.index === index ? drag : null;
                const left = start - (dragged?.edge === "start" ? dragged.delta : 0);
                const size = length + (dragged?.delta ?? 0);
                return (
                  <div
                    key={clip.key}
                    ref={(element) => {
                      if (element) options.current.set(clip.key, element);
                      else options.current.delete(clip.key);
                    }}
                    className="hm-video-timeline-clip"
                    role="option"
                    aria-selected={selectedClips.includes(clip.key)}
                    tabIndex={index === focusIndex ? 0 : -1}
                    data-hm-key={clip.key}
                    data-hm-muted={clip.muted || undefined}
                    data-hm-dragging={dragged ? "" : undefined}
                    aria-label={messages.t(clip.muted ? "timeline.clipMuted" : "timeline.clip", {
                      index: index + 1,
                      count: clips.length,
                      start: timecode(start),
                      end: timecode(start + length),
                    })}
                    style={{
                      insetInlineStart: `${left * pixelsPerFrame}px`,
                      inlineSize: `${size * pixelsPerFrame}px`,
                    }}
                    onFocus={() => setFocusKey(clip.key)}
                  >
                    <span
                      className="hm-video-timeline-edge"
                      data-hm-edge="start"
                      aria-hidden="true"
                      onPointerDown={(event) => startDrag(event, index, "start")}
                    />
                    <span
                      className="hm-video-timeline-edge"
                      data-hm-edge="end"
                      aria-hidden="true"
                      onPointerDown={(event) => startDrag(event, index, "end")}
                    />
                  </div>
                );
              })}
            </div>
            <div
              className="hm-video-timeline-line"
              aria-hidden="true"
              style={{ insetInlineStart: `${playhead * pixelsPerFrame}px` }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
