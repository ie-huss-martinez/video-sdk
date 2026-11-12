/**
 * Every time in the model is a whole number of microseconds, the unit
 * WebCodecs uses for timestamps, and every edit lands on the output's frame
 * grid (ADR 0003). Seconds appear only at the edges: in the UI and in
 * events.
 */

/** Microseconds in one second. */
const MICROSECONDS = 1_000_000;

/**
 * A frame rate as a fraction, such as `{ num: 30000, den: 1001 }` for 29.97
 * frames per second, so that common rates are exact.
 *
 * @public
 */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/**
 * Whether a frame rate is two positive safe integers.
 *
 * @public
 */
export function isFrameRate(rate: FrameRate): boolean {
  return (
    Number.isSafeInteger(rate.num) && Number.isSafeInteger(rate.den) && rate.num > 0 && rate.den > 0
  );
}

/**
 * When output frame `frame` starts, in microseconds from the start of the
 * timeline: `round(frame × 1,000,000 × den ÷ num)` (ADR 0003). It's also the
 * length of `frame` frames.
 *
 * @param frame - A whole number of frames.
 * @param rate - The output's frame rate.
 * @public
 */
export function frameTime(frame: number, rate: FrameRate): number {
  return Math.round((frame * MICROSECONDS * rate.den) / rate.num);
}

/**
 * How many whole output frames a length in microseconds covers, rounded to
 * the nearest frame.
 *
 * @param duration - A length in microseconds.
 * @param rate - The output's frame rate.
 * @public
 */
export function framesIn(duration: number, rate: FrameRate): number {
  return Math.round((duration * rate.num) / (MICROSECONDS * rate.den));
}

/**
 * Whether a source range `[start, end)` covers a whole number of output
 * frames, at least one: its `end` is `start + frameTime(n)` for some `n ≥ 1`,
 * within one microsecond (ADR 0003). The microsecond allows for rounding:
 * when a clip is split, each half is rounded to whole microseconds, so a
 * half's length can differ from `frameTime(n)` by one.
 *
 * @public
 */
export function isOnGrid(start: number, end: number, rate: FrameRate): boolean {
  const frames = framesIn(end - start, rate);
  return frames >= 1 && Math.abs(end - (start + frameTime(frames, rate))) <= 1;
}

/**
 * Converts microseconds to seconds, for display and events.
 *
 * @public
 */
export function microsecondsToSeconds(microseconds: number): number {
  return microseconds / MICROSECONDS;
}

/**
 * Converts seconds to the nearest whole microsecond, for input from the UI,
 * such as a typed trim point. Snap the result to the grid before building a
 * command.
 *
 * @public
 */
export function secondsToMicroseconds(seconds: number): number {
  return Math.round(seconds * MICROSECONDS);
}

/**
 * Whether a value is a non-negative safe integer: a valid time, length or
 * frame index.
 *
 * @internal
 */
export function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
