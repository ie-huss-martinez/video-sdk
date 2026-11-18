import { useTimelineScale } from "@hussmartinez/ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { gainAt } from "../core/model/envelope.js";
import { peakColumns } from "../core/model/peaks.js";
import type { VideoClip } from "../core/model/plan.js";
import type { VideoPeaks } from "../core/model/source.js";
import { type FrameRate, frameTime } from "../core/model/time.js";

/** Subscribes to the timeline's scrolling, zooming and resizing; returns how to stop. */
export type RangeSubscription = (listener: () => void) => () => void;

/** What the waveform draws: the plan's clips, where each starts, and their rate. */
interface WaveformPlan {
  readonly clips: readonly VideoClip[];
  /** Each clip's first output frame, and the plan's length last. */
  readonly offsets: readonly number[];
  readonly rate: FrameRate;
}

/**
 * Draws the clips' sound from their sources' peaks, never from samples
 * (ADR 0008): for each clip in view, its part of its source, at its volume
 * and fades as `gainAt` shapes them, the same envelope playback and export
 * apply, so what's seen is what's heard, and a muted clip is flat. Only the
 * range in view is drawn, on a canvas as wide as the viewport, so drawing
 * costs the same at any length and any zoom. As audio-sdk's `AudioWaveform`.
 */
function draw(
  canvas: HTMLCanvasElement,
  plan: WaveformPlan,
  scale: ReturnType<typeof useTimelineScale>,
  peaksOf: (source: string) => VideoPeaks | undefined,
): void {
  const range = scale.visibleRange();
  const left = scale.toPixels(range.start);
  const cssWidth = Math.max(0, scale.toPixels(range.end) - left);
  // Sized and placed through the CSSOM, which a strict Content Security
  // Policy allows, never with a style attribute.
  canvas.style.insetInlineStart = `${left}px`;
  canvas.style.inlineSize = `${cssWidth}px`;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || width === 0 || height === 0 || scale.pixelsPerUnit === 0) return;

  const style = getComputedStyle(canvas);
  context.fillStyle = style.color;
  // In a right-to-left layout, time runs leftward.
  const mirrored = style.direction === "rtl";
  const middle = height / 2;

  for (const [index, clip] of plan.clips.entries()) {
    const start = plan.offsets[index] ?? 0;
    const end = plan.offsets[index + 1] ?? start;
    const from = Math.max(start, range.start);
    const to = Math.min(end, range.end);
    if (to <= from) continue;
    const peaks = peaksOf(clip.source);
    if (!peaks) continue;
    // The clip's own time, in microseconds from its start, and its source's.
    const into = (frame: number) =>
      Math.min(clip.end - clip.start, frameTime(frame - start, plan.rate));
    const fromTime = into(from);
    const toTime = into(to);
    if (toTime <= fromTime) continue;
    const x0 = (scale.toPixels(from) - left) * ratio;
    const x1 = (scale.toPixels(to) - left) * ratio;
    const columns = Math.max(1, Math.round(x1 - x0));
    const { min, max } = peakColumns(peaks, {
      from: Math.round(clip.start + fromTime),
      to: Math.round(clip.start + toTime),
      columns,
    });
    const perColumn = (toTime - fromTime) / columns;
    for (let column = 0; column < columns; column += 1) {
      // The envelope at the column's middle, with microseconds as samples.
      const gain = gainAt(clip, Math.floor(fromTime + (column + 0.5) * perColumn), 1_000_000);
      const high = Math.min(1, Math.max(-1, (max[column] as number) * gain));
      const low = Math.min(1, Math.max(-1, (min[column] as number) * gain));
      const x = Math.floor(x0) + column;
      context.fillRect(
        mirrored ? width - x - 1 : x,
        middle - high * middle,
        1,
        Math.max(1, (high - low) * middle),
      );
    }
  }
}

/**
 * The video track's sound, inside a `TimelineLayer` under the clips, which
 * is `aria-hidden`: what it shows is in the clips' names, muted or not. It
 * redraws on the next animation frame after the plan, the peaks, the zoom,
 * the scroll, the size or the colour scheme changes, and never as the
 * playhead moves.
 */
export function VideoWaveform({
  plan,
  peaksOf,
  peaksVersion,
  subscribeRange,
}: {
  readonly plan: WaveformPlan;
  readonly peaksOf: (source: string) => VideoPeaks | undefined;
  readonly peaksVersion: number;
  readonly subscribeRange: RangeSubscription;
}): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scale = useTimelineScale();

  // biome-ignore lint/correctness/useExhaustiveDependencies: peaksVersion says new peaks arrived, which peaksOf returns.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let request = 0;
    const schedule = () => {
      cancelAnimationFrame(request);
      request = requestAnimationFrame(() => draw(element, plan, scale, peaksOf));
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const queries = ["(prefers-color-scheme: dark)", "(forced-colors: active)"].map((query) =>
      matchMedia(query),
    );
    for (const query of queries) query.addEventListener("change", schedule);
    const unsubscribe = subscribeRange(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
      unsubscribe();
      for (const query of queries) query.removeEventListener("change", schedule);
    };
  }, [plan, scale, peaksOf, peaksVersion, subscribeRange]);

  // Hidden from assistive technology by its layer, which holds only it.
  return <canvas ref={canvas} className="hm-video-timeline-waveform" />;
}
