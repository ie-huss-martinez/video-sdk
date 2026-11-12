import type { VideoError } from "../errors/video-error.js";
import type { VideoPlan } from "../model/plan.js";

/**
 * Whether the output is playing.
 *
 * @public
 */
export type VideoOutputState = "stopped" | "playing" | "paused";

/**
 * The output's state, for `useSyncExternalStore`. A new object on every
 * change. The playhead isn't in it, because it changes on every frame
 * (ADR 0003); read it with {@link VideoOutput.position}.
 *
 * @public
 */
export interface VideoOutputSnapshot {
  readonly state: VideoOutputState;
  /** Frames skipped since the plan was loaded, because decoding couldn't keep up (ADR 0005). */
  readonly droppedFrames: number;
  /**
   * Why playback stopped, such as `DECODE_FAILED` when a frame doesn't
   * decode, or `null`. Playback pauses when it fails; the next `play`,
   * `seek` or `load` clears it.
   */
  readonly error: VideoError | null;
  /**
   * `"blocked"` when audio couldn't play: the browser's autoplay rules kept
   * it from starting, the browser has no audio output, or the output stopped
   * keeping time. Playback goes on silently on the performance clock, and
   * the next `play` from a user gesture tries again. `"ready"` otherwise,
   * including for a plan without audio.
   */
  readonly audio: VideoOutputAudio;
}

/**
 * Whether an output's audio can play.
 *
 * @public
 */
export type VideoOutputAudio = "ready" | "blocked";

/**
 * What a {@link VideoOutput} tells its listeners about, apart from changes of
 * state: `ended` when playback reaches the end of the plan.
 *
 * @public
 */
export type VideoOutputEvent = "ended";

/**
 * The highest device pixel ratio an output draws at. A larger ratio is drawn
 * at this one: no display needs more, and it bounds the canvas a runaway
 * layout can ask for.
 *
 * @public
 */
export const MAX_PIXEL_RATIO = 4;

/**
 * The size of an output canvas's backing store for a stage of `width` ×
 * `height` CSS pixels at `pixelRatio`, at most {@link MAX_PIXEL_RATIO}, in
 * whole pixels, at least 1.
 *
 * @public
 */
export function backingSize(
  width: number,
  height: number,
  pixelRatio = 1,
): { readonly width: number; readonly height: number } {
  const ratio = Math.min(pixelRatio, MAX_PIXEL_RATIO);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * The port for playback (ADR 0002, ADR 0003, ADR 0005, ADR 0008). Playback
 * is a function of the plan and the playhead: loading a changed plan or
 * seeking while playing continues from the current position. The SDK's own
 * adapter plays sources opened with its engine, with the `AudioContext` as
 * the clock; tests use a fake with a manual clock.
 *
 * Positions are output frames on the plan's timeline, from 0 to the plan's
 * length.
 *
 * @public
 */
export interface VideoOutput {
  getSnapshot(): VideoOutputSnapshot;
  /** Calls the listener after every change of state. Returns a function that unsubscribes. */
  subscribe(listener: () => void): () => void;
  /** The playhead: the output frame being shown, read from the playback clock. */
  position(): number;
  /**
   * Sets what plays. Every clip's source must be open in the engine. While
   * playing, playback continues from the current position with the new
   * plan. A playhead past the new plan's end moves to its end.
   */
  load(plan: VideoPlan): void;
  /**
   * Plays from the playhead, or from the start when the playhead is at the
   * end. The first call may need a user gesture, as browsers' autoplay rules
   * require. When playback reaches the end, the state becomes `stopped`, the
   * playhead stays at the end with the last frame shown, and `ended` fires,
   * once.
   */
  play(): Promise<void>;
  /** Pauses, keeping the playhead. */
  pause(): void;
  /** Stops, and moves the playhead to the start. */
  stop(): void;
  /** Moves the playhead to an output frame, clamped to the plan. While playing, playback continues from there. */
  seek(frame: number): void;
  /**
   * Shows the next frame, `1`, or the previous one, `-1`, exactly, pausing
   * if playing (docs/adr/0006). Stepping past either end of the plan does
   * nothing. A playhead at the end shows the last frame, so stepping back
   * from it shows the one before.
   */
  step(delta: 1 | -1): void;
  /**
   * Calls the listener on each `ended`: when playback reaches the end of the
   * plan, never on a seek or a step to it. Returns a function that
   * unsubscribes.
   */
  on(event: VideoOutputEvent, listener: () => void): () => void;
  /**
   * Sizes the canvas's backing store for a stage of `width` × `height` CSS
   * pixels at `pixelRatio`, such as `devicePixelRatio`, which defaults to 1:
   * see {@link backingSize}. The frame shown is kept, and redrawn sharp at
   * the new size. Call it when the stage's size or the ratio changes.
   *
   * Throws `TypeError` for a size or ratio that isn't a positive finite
   * number, and `VideoError` with `FRAME_TOO_LARGE` when the backing size is
   * over the output's `maxFramePixels`; the canvas then keeps its size.
   */
  resize(width: number, height: number, pixelRatio?: number): void;
  /** Stops playback and releases the audio device and decoders. Later calls throw. */
  destroy(): Promise<void>;
}
