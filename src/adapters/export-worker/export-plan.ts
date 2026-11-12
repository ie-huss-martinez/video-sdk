import { abortError, throwIfAborted } from "../../core/errors/error-helpers.js";
import { isVideoError, VideoError } from "../../core/errors/video-error.js";
import {
  audioBitrate,
  type ExportCandidate,
  exportCandidates,
  exportSampleRate,
  keyFrameInterval,
  videoBitrate,
} from "../../core/export/encoding.js";
import { clipFrames, clipOffsets, planFrames, type VideoPlan } from "../../core/model/plan.js";
import { frameTime } from "../../core/model/time.js";
import { composeFrame } from "../../core/playback/compose.js";
import { TIMESTAMP_TOLERANCE } from "../../core/playback/scheduler.js";
import type { VideoExportContainer, VideoExportQuality } from "../../core/ports/video-processor.js";
import { paint } from "../canvas/paint.js";
import { mixAudioWindow } from "../media-worker/audio-window.js";
import type { PlaybackSource } from "../media-worker/contract.js";
import { createReaderCache } from "../media-worker/readers.js";
import { createExportWriter, type ExportWriter } from "../mediabunny/export-writer.js";
import { MAX_DECODE_QUEUE } from "../mediabunny/video-decoder.js";

/**
 * Counts the frames an export made or cloned and hasn't closed, for the
 * tests that prove every frame is closed on every path (docs/adr/0002).
 *
 * @internal
 */
export const exportLedger = { frames: 0 };

/** What the page sends to export a plan. */
export interface ExportRequest {
  readonly plan: VideoPlan;
  readonly sources: readonly PlaybackSource[];
  readonly container?: VideoExportContainer;
  readonly quality?: VideoExportQuality;
}

/** The most encoder chunks waiting for the muxer before the encoders wait (docs/adr/0002). */
const MAX_PENDING_WRITES = 16;
/** Audio is made in windows of a tenth of a second, as the video reaches them. */
const AUDIO_WINDOW_SECONDS = 0.1;

function videoConfig(
  plan: VideoPlan,
  candidate: ExportCandidate,
  quality: VideoExportQuality,
): VideoEncoderConfig {
  const { output } = plan;
  return {
    codec: candidate.video.codec,
    width: output.width,
    height: output.height,
    bitrate: videoBitrate(output, quality),
    framerate: output.frameRate.num / output.frameRate.den,
    latencyMode: "quality",
    ...(candidate.video.muxer === "avc" ? { avc: { format: "avc" } } : {}),
  };
}

function audioConfig(
  plan: VideoPlan,
  candidate: ExportCandidate,
  quality: VideoExportQuality,
): AudioEncoderConfig {
  return {
    codec: candidate.audio.codec,
    sampleRate: exportSampleRate(plan.output, candidate),
    numberOfChannels: plan.output.channels,
    bitrate: audioBitrate(plan.output, quality),
  };
}

/** Whether this browser encodes a configuration: it says so, and one black frame encodes (docs/adr/0001). */
async function provesVideo(config: VideoEncoderConfig): Promise<boolean> {
  try {
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return false;
  } catch {
    return false;
  }
  let produced = false;
  let failed = false;
  const encoder = new VideoEncoder({
    output: () => {
      produced = true;
    },
    error: () => {
      failed = true;
    },
  });
  try {
    encoder.configure(config);
    const canvas = new OffscreenCanvas(config.width, config.height);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    context.fillRect(0, 0, config.width, config.height);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    return produced && !failed;
  } catch {
    return false;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

/** Whether this browser encodes an audio configuration: it says so, and one silent chunk encodes. */
async function provesAudio(config: AudioEncoderConfig): Promise<boolean> {
  try {
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return false;
  } catch {
    return false;
  }
  let produced = false;
  let failed = false;
  const encoder = new AudioEncoder({
    output: () => {
      produced = true;
    },
    error: () => {
      failed = true;
    },
  });
  try {
    encoder.configure(config);
    // A tenth of a second, more than any codec's frame.
    const frames = Math.round(config.sampleRate / 10);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: config.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: config.numberOfChannels,
      timestamp: 0,
      data: new Float32Array(frames * config.numberOfChannels),
    });
    encoder.encode(data);
    data.close();
    await encoder.flush();
    return produced && !failed;
  } catch {
    return false;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

/**
 * The first candidate this browser can encode, proved by encoding with it
 * (docs/adr/0001). Throws `UNSUPPORTED_CODEC` when none can, or
 * `UNSUPPORTED_ENVIRONMENT` without WebCodecs' encoders.
 */
async function chooseCandidate(
  plan: VideoPlan,
  quality: VideoExportQuality,
  withAudio: boolean,
  container: VideoExportContainer | undefined,
): Promise<ExportCandidate> {
  for (const feature of ["VideoEncoder", "AudioEncoder"] as const) {
    if (typeof globalThis[feature] !== "function") {
      throw new VideoError(
        "UNSUPPORTED_ENVIRONMENT",
        `This browser has no ${feature} in workers.`,
        {
          details: { feature },
        },
      );
    }
  }
  const proved = new Map<string, boolean>();
  const cached = async (key: string, prove: () => Promise<boolean>) => {
    if (!proved.has(key)) proved.set(key, await prove());
    return proved.get(key) as boolean;
  };
  for (const candidate of exportCandidates(plan.output, container)) {
    const video = videoConfig(plan, candidate, quality);
    if (!(await cached(`v:${video.codec}`, () => provesVideo(video)))) continue;
    if (withAudio) {
      const audio = audioConfig(plan, candidate, quality);
      if (!(await cached(`a:${audio.codec}`, () => provesAudio(audio)))) continue;
    }
    return candidate;
  }
  throw new VideoError("UNSUPPORTED_CODEC", "This browser can't encode the export.", {
    details: { codec: container ?? "mp4/webm", track: "video" },
  });
}

/** Waits for an encoder's queue to drop below `size`, or for a failure. */
function belowQueue(
  encoder: VideoEncoder | AudioEncoder,
  size: number,
  check: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const test = () => {
      try {
        check();
      } catch (error) {
        encoder.removeEventListener("dequeue", test);
        reject(error);
        return;
      }
      if (encoder.encodeQueueSize < size) {
        encoder.removeEventListener("dequeue", test);
        resolve();
      }
    };
    encoder.addEventListener("dequeue", test);
    test();
  });
}

/**
 * Exports a plan in the export worker (docs/adr/0005): every output frame is
 * decoded, composed and encoded again, the audio is mixed and encoded on the
 * same timeline, and both are written into the container. Nothing is copied
 * from a source. Memory stays at the queues' bounds and the file.
 *
 * Throws `VideoError`: `UNSUPPORTED_CODEC`, `ENCODE_FAILED` with
 * `details.codec`, the decoder's codes, and `ABORTED` or the abort reason's
 * code when cancelled. Every frame is closed on every path.
 *
 * @internal
 */
export async function exportPlan(
  request: ExportRequest,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const { plan } = request;
  const quality = request.quality ?? "medium";
  const sources = new Map(request.sources.map((source) => [source.id, source]));
  for (const clip of plan.clips) {
    if (!sources.has(clip.source)) throw new TypeError(`The source "${clip.source}" isn't open.`);
  }
  const total = planFrames(plan);
  if (total === 0) throw new VideoError("INVALID_COMMAND", "An empty plan can't be exported.");
  const withAudio = plan.clips.some((clip) => sources.get(clip.source)?.probe.audio);
  const readers = createReaderCache();
  readers.setSources(sources);

  let writer: ExportWriter | undefined;
  let videoEncoder: VideoEncoder | undefined;
  let audioEncoder: AudioEncoder | undefined;
  let failure: unknown;
  let writes: Promise<void> = Promise.resolve();
  let pendingWrites = 0;
  const check = () => {
    if (signal.aborted) throw abortError(signal);
    if (failure !== undefined) throw failure;
  };
  const write = (add: () => Promise<void>) => {
    pendingWrites += 1;
    writes = writes
      .then(add)
      .catch((error: unknown) => {
        failure ??= error;
      })
      .finally(() => {
        pendingWrites -= 1;
      });
  };

  try {
    throwIfAborted(signal);
    const candidate = await chooseCandidate(plan, quality, withAudio, request.container);
    throwIfAborted(signal);
    const { output } = plan;
    writer = await createExportWriter(
      candidate,
      plan.metadata,
      output.frameRate.num / output.frameRate.den,
      withAudio,
    );
    const activeWriter = writer;
    const encodeFailed = (codec: string) => (error: unknown) => {
      failure ??= new VideoError("ENCODE_FAILED", "The browser couldn't encode the export.", {
        details: { codec },
        cause: error,
      });
    };
    const video = videoConfig(plan, candidate, quality);
    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => write(() => activeWriter.addVideo(chunk, meta)),
      error: encodeFailed(video.codec),
    });
    videoEncoder.configure(video);
    const audio = withAudio ? audioConfig(plan, candidate, quality) : undefined;
    if (audio) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => write(() => activeWriter.addAudio(chunk, meta)),
        error: encodeFailed(audio.codec),
      });
      audioEncoder.configure(audio);
    }

    const canvas = new OffscreenCanvas(output.width, output.height);
    const context = canvas.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D;
    const rate = output.frameRate;
    const interval = keyFrameInterval(output);
    const audioRate = audio?.sampleRate ?? 0;
    const audioTotal = Math.round((frameTime(total, rate) * audioRate) / 1_000_000);
    let audioNext = 0;
    let lastProgress = 0;

    /** Encodes the audio up to timeline time `time`, in windows. */
    const encodeAudioTo = async (time: number) => {
      if (!audioEncoder) return;
      const until = Math.min(audioTotal, Math.round((time * audioRate) / 1_000_000));
      while (audioNext < until) {
        check();
        const count = Math.min(Math.round(audioRate * AUDIO_WINDOW_SECONDS), until - audioNext);
        const channels = await mixAudioWindow(
          plan,
          sources,
          readers.readerFor,
          audioNext,
          count,
          audioRate,
          signal,
        );
        const planar = new Float32Array(count * channels.length);
        for (const [index, channel] of channels.entries()) planar.set(channel, index * count);
        await belowQueue(audioEncoder, MAX_DECODE_QUEUE, check);
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: audioRate,
          numberOfFrames: count,
          numberOfChannels: channels.length,
          timestamp: Math.round((audioNext * 1_000_000) / audioRate),
          data: planar,
        });
        audioEncoder.encode(data);
        data.close();
        audioNext += count;
      }
    };

    /** Composes, encodes and accounts for output frame `n`, showing `held`, or black without one. */
    const emit = async (n: number, held: VideoFrame | undefined, index: number) => {
      check();
      const clip = plan.clips[index];
      const probe = clip && sources.get(clip.source)?.probe;
      context.fillStyle = "#000";
      context.fillRect(0, 0, output.width, output.height);
      if (held && clip && probe) {
        const composition = composeFrame(
          output,
          canvas,
          {
            width: probe.video.displayWidth,
            height: probe.video.displayHeight,
            rotation: probe.video.rotation,
          },
          clip.transform,
        );
        paint(context, held, composition);
      }
      const encoder = videoEncoder as VideoEncoder;
      await belowQueue(encoder, MAX_DECODE_QUEUE, check);
      if (pendingWrites > MAX_PENDING_WRITES) await writes;
      check();
      const frame = new VideoFrame(canvas, {
        timestamp: frameTime(n, rate),
        duration: frameTime(n + 1, rate) - frameTime(n, rate),
      });
      exportLedger.frames += 1;
      try {
        encoder.encode(frame, { keyFrame: n % interval === 0 });
      } finally {
        frame.close();
        exportLedger.frames -= 1;
      }
      await encodeAudioTo(frameTime(n + 1, rate));
      const now = performance.now();
      if (now - lastProgress >= 100) {
        lastProgress = now;
        onProgress((n + 1) / total);
      }
    };

    const offsets = clipOffsets(plan);
    let n = 0;
    for (const [index, clip] of plan.clips.entries()) {
      const probe = (sources.get(clip.source) as PlaybackSource).probe;
      const last = (offsets[index] as number) + clipFrames(clip, rate);
      const first = offsets[index] as number;
      const target = (k: number) => clip.start + frameTime(k - first, rate);
      let held: VideoFrame | undefined;
      const release = () => {
        if (!held) return;
        held.close();
        exportLedger.frames -= 1;
        held = undefined;
      };
      try {
        const reader = await readers.readerFor(clip.source);
        await reader.decode(
          {
            keyFrom: probe.start + clip.start + TIMESTAMP_TOLERANCE,
            from: Number.NEGATIVE_INFINITY,
            to: probe.start + clip.end,
          },
          async (decoded) => {
            const time = decoded.timestamp - probe.start;
            // Every output frame before this one shows the frame held.
            while (n < last && target(n) + TIMESTAMP_TOLERANCE < time) {
              await emit(n, held, index);
              n += 1;
            }
            release();
            held = decoded.clone();
            exportLedger.frames += 1;
          },
          signal,
        );
        while (n < last) {
          await emit(n, held, index);
          n += 1;
        }
      } finally {
        release();
      }
    }

    await encodeAudioTo(frameTime(total, rate));
    await videoEncoder.flush();
    await audioEncoder?.flush();
    await writes;
    check();
    const file = await writer.finish();
    onProgress(1);
    return file;
  } catch (error) {
    await writer?.cancel().catch(() => {});
    if (isVideoError(error) || error instanceof TypeError) throw error;
    if (failure !== undefined) throw failure;
    if (signal.aborted) throw abortError(signal);
    throw new VideoError("ENCODE_FAILED", "The browser couldn't encode the export.", {
      details: { codec: "unknown" },
      cause: error,
    });
  } finally {
    for (const encoder of [videoEncoder, audioEncoder]) {
      if (encoder && encoder.state !== "closed") encoder.close();
    }
    readers.dispose();
  }
}
