import { createWorkerClient } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { createVideoEngine } from "../src/adapters/video-engine.js";
import { createVideoProcessor } from "../src/adapters/video-processor.js";
import { VideoError, type VideoPlan } from "../src/index.js";
import { clipOf, planOf } from "./contracts/helpers.js";
import cutTones from "./fixtures/video/cut-tones.webm?url";
import numberedBeeps from "./fixtures/video/numbered-beeps.webm?url";
import privateMetadata from "./fixtures/video/private-metadata.mkv?url";
import { unreadable } from "./support/codecs.js";
import type { InspectContract } from "./workers/inspect.worker.js";

// What an export contains, read from its bytes (docs/adr/0005): nothing from
// a source but the plan's frames and audio, no audio that was cut, and
// picture and sound in step. Each file is decoded in the engine that made it.

const FRAME = 1_000_000 / 30;

const inspector = createWorkerClient<InspectContract>({
  createWorker: () =>
    new Worker(new URL("./workers/inspect.worker.ts", import.meta.url), { type: "module" }),
  errorClasses: { VideoError },
});

async function exportOf(url: string, plan: (source: Parameters<typeof clipOf>[1]) => VideoPlan) {
  const engine = createVideoEngine();
  const file = await (await fetch(url)).blob();
  const source = await engine.open("s", file, await engine.probe(file));
  const processor = createVideoProcessor({ engine });
  try {
    return await processor.export({ plan: plan(source) });
  } finally {
    await processor.destroy();
    await engine.destroy();
  }
}

/** A plan at the fixtures' size, 256 × 32. */
function smallPlan(...clips: Parameters<typeof planOf>): VideoPlan {
  const plan = planOf(...clips);
  return { ...plan, output: { ...plan.output, width: 256, height: 32 } };
}

/**
 * A file's audio as a player hears it, mixed to mono at 48 kHz: decoded by
 * the page's Web Audio, which applies the container's edit list and the
 * codec's priming, as a browser's player does. (WebKit's WebCodecs decoder
 * stamps AAC chunks too unreliably to place them, so it isn't used here.)
 */
async function heard(file: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const context = new OfflineAudioContext(1, 1, 48_000);
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const samples = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let k = 0; k < samples.length; k += 1) {
      samples[k] = (samples[k] as number) + (data[k] as number) / buffer.numberOfChannels;
    }
  }
  return { samples, sampleRate: buffer.sampleRate };
}

/** The power of one frequency in a stretch of samples, by the Goertzel algorithm. */
function power(samples: Float32Array, sampleRate: number, frequency: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let before = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - before;
    before = previous;
    previous = current;
  }
  return (previous * previous + before * before - coefficient * previous * before) / samples.length;
}

/** Where tones start, in seconds: a sample over 0.05 after at least 100 ms of quiet. */
function onsets(samples: Float32Array, sampleRate: number): number[] {
  const found: number[] = [];
  let quietSince = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < samples.length; k += 1) {
    if (Math.abs(samples[k] as number) > 0.05) {
      if (k - quietSince > sampleRate / 10) found.push(k / sampleRate);
      quietSince = k;
    }
  }
  return found;
}

describe("what an export contains, and nothing else", () => {
  it("carries none of a source's metadata, tracks or chapters, only what the plan sets", async (context) => {
    const reason = await unreadable();
    if (reason) context.skip(reason);
    const exported = await exportOf(privateMetadata, (source) => ({
      ...smallPlan(clipOf("x", source, 0, 30)),
      metadata: { title: "Harbour", description: "", artist: "Ana", date: "", comment: "" },
    }));
    // The source carries every marker, so their absence below means something.
    const source = new TextDecoder("latin1").decode(
      await (await (await fetch(privateMetadata)).blob()).arrayBuffer(),
    );
    for (const marker of [
      "MARKER-TITLE",
      "MARKER-SUBTITLE",
      "MARKER-CHAPTER",
      "MARKER-DEVICE",
      "+48.8584",
    ]) {
      expect(source, `fixture carries ${marker}`).toContain(marker);
    }
    // Every byte, as text: a marker anywhere, in any box or element, fails.
    const text = new TextDecoder("latin1").decode(await exported.arrayBuffer());
    for (const marker of [
      "MARKER-",
      "7731",
      "+48.8584",
      "+002.2945",
      "Lavf",
      "Lavc",
      "libvpx",
      "libopus",
    ]) {
      expect(text, marker).not.toContain(marker);
    }
    expect(text).toContain("Harbour");
    // The only strings mediabunny writes of its own are its name and version,
    // and its MP4 handler names: the same in every export (docs/adr/0005).
    const own = new Set(text.match(/Mediabunny[\x20-\x7e]*/g) ?? []);
    for (const found of own) {
      expect(found).toMatch(/^Mediabunny(?: v\d+\.\d+\.\d+(?:WA)?|VideoHandler|SoundHandler)$/);
    }
    const read = await inspector.call("inspect", exported);
    expect(read.metadata).toEqual({ title: "Harbour", artist: "Ana" });
    // A video track and an audio track: the source's subtitle track is gone.
    expect(read.tracks).toBe(2);
  });

  it("leaves out the audio of a part that was cut", async (context) => {
    const reason = await unreadable();
    if (reason) context.skip(reason);
    // 440 Hz, then 1 kHz, then 660 Hz, a second each; the middle second is cut.
    const exported = await exportOf(cutTones, (source) =>
      smallPlan(clipOf("a", source, 0, 30), clipOf("b", source, 2_000_000, 30)),
    );
    const read = await inspector.call("inspect", exported);
    expect(read.numbers).toEqual([
      ...[...Array(30).keys()],
      ...[...Array(30).keys()].map((n) => n + 60),
    ]);
    const { samples, sampleRate } = await heard(exported);
    // A second either side, leaving the codec's edges and the cut's own click out.
    const first = samples.slice(Math.round(sampleRate * 0.1), Math.round(sampleRate * 0.9));
    const second = samples.slice(Math.round(sampleRate * 1.1), Math.round(sampleRate * 1.9));
    const whole = samples.slice(0, sampleRate * 2);
    expect(power(first, sampleRate, 440)).toBeGreaterThan(100 * power(first, sampleRate, 1_000));
    expect(power(second, sampleRate, 660)).toBeGreaterThan(100 * power(second, sampleRate, 1_000));
    // The cut tone is nowhere: under a hundredth of a kept tone's power.
    expect(power(whole, sampleRate, 1_000)).toBeLessThan(power(first, sampleRate, 440) / 100);
  });

  it("keeps each flash within one frame of its tone in the file, across cuts", async (context) => {
    const reason = await unreadable();
    if (reason) context.skip(reason);
    // Source seconds 2–4, then 0–2: tones under frames 75, 105, 15 and 45, at
    // timeline frames 15, 45, 75 and 105.
    const exported = await exportOf(numberedBeeps, (source) =>
      smallPlan(clipOf("b", source, 2_000_000, 60), clipOf("a", source, 0, 60)),
    );
    const read = await inspector.call("inspect", exported);
    const { samples, sampleRate } = await heard(exported);
    const tones = onsets(samples, sampleRate);
    expect(tones).toHaveLength(4);
    for (const [index, flash] of [75, 105, 15, 45].entries()) {
      const at = read.numbers.indexOf(flash);
      expect(at, `flash ${flash} in the file`).toBeGreaterThanOrEqual(0);
      const shown = (read.timestamps[at] as number) / 1_000_000;
      const heard = tones[index] as number;
      expect(
        Math.abs(shown - heard) * 1_000,
        `flash ${flash}: ${((shown - heard) * 1_000).toFixed(1)} ms from its tone`,
      ).toBeLessThanOrEqual(FRAME / 1_000);
    }
  });
});
