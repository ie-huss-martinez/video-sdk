import { mixWindow, type SourceSamples, sourceSpan } from "../../core/audio/mix.js";
import type { VideoPlan } from "../../core/model/plan.js";
import type { VideoProbe } from "../../core/model/source.js";
import type { FrameReader } from "../mediabunny/frame-reader.js";
import type { PlaybackSource } from "./contract.js";

/**
 * Makes one window of a plan's audio (docs/adr/0005): `count` samples at
 * `rate` from timeline sample `from`, mixed to the output's channels. Each
 * clip's source audio is decoded for just the samples the window needs.
 * Playback and export both make their audio through it.
 *
 * @internal
 */
export async function mixAudioWindow(
  plan: VideoPlan,
  sources: ReadonlyMap<string, PlaybackSource>,
  readerFor: (id: string) => Promise<FrameReader>,
  from: number,
  count: number,
  rate: number,
  signal: AbortSignal,
): Promise<Float32Array[]> {
  const samples = await Promise.all(
    plan.clips.map(async (clip, index) => {
      const source = sources.get(clip.source);
      const sourceRate = source?.probe.audio?.sampleRate;
      if (!source || clip.muted || sourceRate === undefined) return null;
      const span = sourceSpan(plan, index, rate, from, count, sourceRate);
      if (!span) return null;
      const reader = await readerFor(clip.source);
      if (!reader.audio) return null;
      return decodeSpan(reader.audio, source.probe, sourceRate, span, signal);
    }),
  );
  return mixWindow(plan, rate, from, count, (index) => samples[index] ?? null);
}

/**
 * Decodes a span of a source's audio, in source samples counted from the
 * probe's `start`, into planar channels. Each chunk is copied out and closed
 * by the decoder at once; samples outside the span are dropped, and any the
 * file doesn't have stay silent.
 */
async function decodeSpan(
  audio: NonNullable<FrameReader["audio"]>,
  probe: VideoProbe,
  sourceRate: number,
  span: { readonly start: number; readonly end: number },
  signal: AbortSignal,
): Promise<SourceSamples> {
  const length = span.end - span.start;
  const channels = Array.from(
    { length: probe.audio?.channels ?? 1 },
    () => new Float32Array(length),
  );
  let scratch = new Float32Array(0);
  await audio.decode(
    {
      from: probe.start + (span.start * 1_000_000) / sourceRate,
      to: probe.start + (span.end * 1_000_000) / sourceRate,
    },
    (data) => {
      if (scratch.length < data.numberOfFrames) scratch = new Float32Array(data.numberOfFrames);
      const offset =
        Math.round(((data.timestamp - probe.start) * sourceRate) / 1_000_000) - span.start;
      const skip = Math.max(0, -offset);
      const take = Math.min(data.numberOfFrames, length - offset) - skip;
      if (take <= 0) return;
      for (const [planeIndex, channel] of channels.entries()) {
        if (planeIndex >= data.numberOfChannels) break;
        const view = scratch.subarray(0, data.numberOfFrames);
        data.copyTo(view, { planeIndex, format: "f32-planar" });
        channel.set(view.subarray(skip, skip + take), offset + skip);
      }
    },
    signal,
  );
  return { sampleRate: sourceRate, start: span.start, channels };
}
