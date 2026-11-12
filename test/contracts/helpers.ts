import {
  clipEnd,
  createPlan,
  type FrameRate,
  IDENTITY_TRANSFORM,
  NO_FADE,
  type VideoClip,
  type VideoPlan,
  type VideoSourceInfo,
} from "../../src/index.js";

export const RATE: FrameRate = { num: 30, den: 1 };

/** A clip of `frames` output frames at 30 fps from `start` microseconds of a source. */
export function clipOf(
  key: string,
  source: VideoSourceInfo,
  start: number,
  frames: number,
): VideoClip {
  return {
    key,
    source: source.id,
    start,
    end: clipEnd(start, frames, RATE),
    volumeDb: 0,
    muted: false,
    fadeIn: NO_FADE,
    fadeOut: NO_FADE,
    transform: IDENTITY_TRANSFORM,
  };
}

/** A plan at 30 fps, 1280 × 720, over these clips. */
export function planOf(...clips: VideoClip[]): VideoPlan {
  return {
    ...createPlan({ width: 1280, height: 720, frameRate: RATE, sampleRate: 48_000, channels: 2 }),
    clips,
  };
}

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

export function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
