import type { VideoClip, VideoFadeCurve } from "./plan.js";

/**
 * Converts decibels to a linear gain factor.
 *
 * @public
 */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

/** A fade's gain at `position`, from 0 (silent) to 1 (full). */
function fadeShape(curve: VideoFadeCurve, position: number): number {
  return curve === "equalPower" ? Math.sin((position * Math.PI) / 2) : position;
}

/**
 * The gain of one audio sample of a clip, from its volume, mute and fades:
 * the single definition of the envelope, which playback and export both
 * apply (ADR 0005).
 *
 * A fade in starts at silence on the clip's first sample, and a fade out
 * reaches silence on its last.
 *
 * @param clip - The clip.
 * @param sample - A sample within the clip, from 0, at `sampleRate`.
 * @param sampleRate - The output's sample rate.
 * @public
 */
export function gainAt(clip: VideoClip, sample: number, sampleRate: number): number {
  if (clip.muted) return 0;
  const toSamples = (microseconds: number) => Math.round((microseconds * sampleRate) / 1_000_000);
  const length = toSamples(clip.end - clip.start);
  let gain = dbToGain(clip.volumeDb);
  const fadeIn = toSamples(clip.fadeIn.duration);
  if (fadeIn > 0 && sample < fadeIn) {
    gain *= fadeShape(clip.fadeIn.curve, sample / fadeIn);
  }
  const fadeOut = toSamples(clip.fadeOut.duration);
  const fromEnd = length - 1 - sample;
  if (fadeOut > 0 && fromEnd < fadeOut) {
    gain *= fadeShape(clip.fadeOut.curve, Math.max(0, fromEnd) / fadeOut);
  }
  return gain;
}
