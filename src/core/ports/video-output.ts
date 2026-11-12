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
   * require. When playback reaches the end, the state becomes `stopped` and
   * the playhead stays at the end.
   */
  play(): Promise<void>;
  /** Pauses, keeping the playhead. */
  pause(): void;
  /** Stops, and moves the playhead to the start. */
  stop(): void;
  /** Moves the playhead to an output frame, clamped to the plan. While playing, playback continues from there. */
  seek(frame: number): void;
  /** Stops playback and releases the audio device and decoders. Later calls throw. */
  destroy(): Promise<void>;
}
