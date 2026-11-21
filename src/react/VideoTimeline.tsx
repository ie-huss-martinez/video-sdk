import {
  IconButton,
  SnapIcon,
  Timeline,
  TimelineClips,
  type TimelineClipsHandle,
  TimelineLayer,
  TimelinePlayhead,
  ToggleButton,
  Toolbar,
  TrimEndIcon,
  TrimStartIcon,
} from "@hussmartinez/ui/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VideoClip } from "../core/model/plan.js";
import { type FrameRate, frameTime } from "../core/model/time.js";
import type { VideoCommand } from "../core/operations/commands.js";
import { useVideoEditor, useVideoOutput, useVideoPlayhead, useVideoSession } from "./context.js";
import { formatTimecode } from "./timecode.js";
import {
  edgeLimits,
  moveTarget,
  offsetsOf,
  type TrimRange,
  trimEdge,
  trimToPlayhead,
} from "./timeline-model.js";
import { VideoWaveform } from "./VideoWaveform.js";

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

// With no plan, the same values on every render, so the memos and the
// effect that depend on them don't run again for nothing.
const NO_CLIPS: readonly VideoClip[] = [];
const DEFAULT_RATE: FrameRate = { num: 30, den: 1 };

/**
 * The timeline (docs/adr/0007), on `ui`'s `Timeline` (ui ADR 0011): the
 * plan's clips on one track, as a horizontal listbox with roving focus, the
 * playhead as a slider on the track, and buttons to snap and trim. Its zoom
 * is the editor's, which the zoom tools set.
 *
 * Every drag has a keyboard alternative, and a single-pointer one: a clip's
 * edges trim by dragging, by `[` and `]` to the playhead, by `Alt+[` and
 * `Alt+]` one frame inward (with `Shift`, outward), and by the trim buttons.
 * `Alt+Left` and `Alt+Right` move the selected clips past their neighbour.
 * `ui` marks the keys it handles, so the editor's shortcuts skip them.
 *
 * @public
 */
export function VideoTimeline(props: VideoTimelineProps): ReactNode {
  const { messages, locale, selectedClips, setSelectedClips, zoom, setMaxZoom } = useVideoEditor();
  const { session, snapshot } = useVideoSession();
  const { output, snapshot: playback } = useVideoOutput();
  const playhead = useVideoPlayhead();
  const plan = snapshot.plan;
  const clips = plan?.clips ?? NO_CLIPS;
  const rate = plan?.output.frameRate ?? DEFAULT_RATE;
  const offsets = useMemo(() => (plan ? offsetsOf(plan) : [0]), [plan]);
  const frames = offsets[offsets.length - 1] ?? 0;

  const region = useRef<HTMLDivElement>(null);
  const track = useRef<TimelineClipsHandle>(null);
  const [snapping, setSnapping] = useState(true);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const hadFocus = useRef(false);
  const knownKeys = useRef<readonly string[] | null>(null);

  // Scrolling and zooming redraw the waveform, without rendering anything.
  const rangeListeners = useRef(new Set<() => void>());
  const subscribeRange = useCallback((listener: () => void) => {
    rangeListeners.current.add(listener);
    return () => {
      rangeListeners.current.delete(listener);
    };
  }, []);
  const peaksOf = useCallback((source: string) => session.getPeaks(source), [session]);
  const waveform = useMemo(() => ({ clips, offsets, rate }), [clips, offsets, rate]);

  const focusIndex = Math.max(
    0,
    clips.findIndex((clip) => clip.key === focusKey),
  );
  const focused = clips[focusIndex];

  // Whether focus is in the editor: in its root, or lost from it, as when the
  // drop zone that had it goes away once a file is in. And which clip has
  // focus, for the trim buttons.
  useEffect(() => {
    const root = region.current?.closest(".hm-video-editor") ?? region.current;
    if (!root) return;
    hadFocus.current = root.contains(document.activeElement);
    const onIn = (event: FocusEvent) => {
      hadFocus.current = true;
      const key = (event.target as Element | null)
        ?.closest?.('[role="option"][data-hm-key]')
        ?.getAttribute("data-hm-key");
      if (key != null && region.current?.contains(event.target as Node)) setFocusKey(key);
    };
    const onOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !root.contains(next)) hadFocus.current = false;
    };
    root.addEventListener("focusin", onIn as EventListener);
    root.addEventListener("focusout", onOut as EventListener);
    return () => {
      root.removeEventListener("focusin", onIn as EventListener);
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
      // The clip renders with this commit; focus it after.
      requestAnimationFrame(() => track.current?.focusClip(key));
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

  const indexOf = (key: string) => clips.findIndex((clip) => clip.key === key);

  const empty = !plan || frames === 0;
  const startTrim =
    plan && focused ? trimToPlayhead(plan, focusIndex, playhead, "start") : undefined;
  const endTrim = plan && focused ? trimToPlayhead(plan, focusIndex, playhead, "end") : undefined;

  return (
    <div className={["hm-video-timeline", props.className].filter(Boolean).join(" ")} ref={region}>
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
      {empty ? null : (
        <Timeline
          label={messages.t("timeline.label")}
          length={frames}
          zoom={zoom}
          maxPixelsPerUnit={MAX_PIXELS_PER_FRAME}
          onMaxZoomChange={setMaxZoom}
          snapping={snapping}
          classNames={{ track: "hm-video-timeline-track" }}
          onVisibleRangeChange={() => {
            for (const listener of rangeListeners.current) listener();
          }}
        >
          <TimelinePlayhead
            label={messages.t("timeline.playhead")}
            position={Math.min(playhead, frames)}
            onPositionChange={(frame) => output?.seek(frame)}
            largeStep={Math.max(1, Math.round(rate.num / rate.den))}
            formatValue={timecode}
            following={playback?.state === "playing"}
          />
          {/* The clips' sound, under them: they let it show through (ADR 0008). */}
          <TimelineLayer className="hm-video-timeline-wave-layer" aria-hidden="true">
            <VideoWaveform
              plan={waveform}
              peaksOf={peaksOf}
              peaksVersion={snapshot.peaksVersion}
              subscribeRange={subscribeRange}
            />
          </TimelineLayer>
          <TimelineClips
            ref={track}
            classNames={{ content: "hm-video-timeline-clip-title" }}
            label={messages.t("timeline.clips")}
            selectionMode="multiple"
            selectedKeys={selectedClips}
            onSelectedKeysChange={setSelectedClips}
            clips={clips.map((clip, index) => {
              const start = offsets[index] ?? 0;
              const length = (offsets[index + 1] ?? start) - start;
              return {
                key: clip.key,
                length,
                label: messages.t(clip.muted ? "timeline.clipMuted" : "timeline.clip", {
                  index: index + 1,
                  count: clips.length,
                  start: timecode(start),
                  end: timecode(start + length),
                }),
                content: messages.t("timeline.clipTitle", { index: index + 1 }),
                attributes: { "data-hm-muted": clip.muted ? "" : undefined },
              };
            })}
            onMove={(keys, direction) => {
              if (!plan) return;
              const to = moveTarget(plan, keys, direction);
              if (to !== undefined) execute({ type: "video.moveClips", keys, to });
              // Focus stays on the clip, wherever it moved.
              const key = focusKey;
              if (key !== null) requestAnimationFrame(() => track.current?.focusClip(key));
            }}
            onTrim={(key, edge, delta) => {
              if (plan) trim(key, trimEdge(plan, indexOf(key), edge, delta));
            }}
            onTrimToPlayhead={(key, edge) => {
              if (plan) trim(key, trimToPlayhead(plan, indexOf(key), playhead, edge));
            }}
            trimLimits={(key, edge) => {
              const index = indexOf(key);
              const source = snapshot.sources.find((each) => each.id === clips[index]?.source);
              return plan && source ? edgeLimits(plan, index, edge, source.duration) : {};
            }}
          />
        </Timeline>
      )}
    </div>
  );
}
