import type { VideoPlanOutput } from "../model/plan.js";
import type { VideoExportContainer, VideoExportQuality } from "../ports/video-processor.js";

/**
 * One way to encode an export, in the order they're tried (docs/adr/0001):
 * the container, and the video and audio codecs, as WebCodecs strings and as
 * the muxer names them.
 *
 * @internal
 */
export interface ExportCandidate {
  readonly container: VideoExportContainer;
  readonly video: { readonly codec: string; readonly muxer: "avc" | "vp9" | "vp8" };
  readonly audio: { readonly codec: string; readonly muxer: "aac" | "opus" };
}

/** H.264 levels: the most macroblocks a frame and a second may hold, and the level's number (docs/adr/0001). */
const H264_LEVELS: readonly (readonly [frame: number, second: number, level: number])[] = [
  [1_620, 40_500, 30],
  [3_600, 108_000, 31],
  [5_120, 216_000, 32],
  [8_192, 245_760, 40],
  [8_704, 522_240, 42],
  [22_080, 589_824, 50],
  [36_864, 983_040, 51],
  [36_864, 2_073_600, 52],
  [139_264, 4_177_920, 60],
  [139_264, 8_355_840, 61],
  [139_264, 16_711_680, 62],
];

/** VP9 levels: the most luma samples a picture and a second may hold, and the level's number. */
const VP9_LEVELS: readonly (readonly [picture: number, second: number, level: number])[] = [
  [36_864, 829_440, 10],
  [73_728, 2_764_800, 11],
  [122_880, 4_608_000, 20],
  [245_760, 9_216_000, 21],
  [552_960, 20_736_000, 30],
  [983_040, 36_864_000, 31],
  [2_228_224, 83_558_400, 40],
  [2_228_224, 160_432_128, 41],
  [8_912_896, 311_951_360, 50],
  [8_912_896, 588_251_136, 51],
  [8_912_896, 1_176_502_272, 52],
  [35_651_584, 1_176_502_272, 60],
  [35_651_584, 2_353_004_544, 61],
  [35_651_584, 4_706_009_088, 62],
];

const framesPerSecond = (output: VideoPlanOutput) => output.frameRate.num / output.frameRate.den;

/**
 * The H.264 High profile codec string at the lowest level whose limits fit
 * the output's size and frame rate (docs/adr/0001): `avc1.6400` and the
 * level, such as `avc1.640028` for 1080p at 30 fps.
 *
 * @internal
 */
export function h264Codec(output: VideoPlanOutput): string {
  const macroblocks = Math.ceil(output.width / 16) * Math.ceil(output.height / 16);
  const perSecond = macroblocks * framesPerSecond(output);
  const fit = H264_LEVELS.find(([frame, second]) => macroblocks <= frame && perSecond <= second);
  const level = fit?.[2] ?? 62;
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

/**
 * The VP9 profile 0 codec string at the lowest level that fits the output,
 * such as `vp09.00.40.08` for 1080p at 30 fps.
 *
 * @internal
 */
export function vp9Codec(output: VideoPlanOutput): string {
  const picture = output.width * output.height;
  const perSecond = picture * framesPerSecond(output);
  const fit = VP9_LEVELS.find(([size, second]) => picture <= size && perSecond <= second);
  return `vp09.00.${fit?.[2] ?? 62}.08`;
}

/**
 * Every way to encode an export, in the order they're tried (docs/adr/0001):
 * MP4 with H.264 and AAC, then H.264 and Opus, then WebM with VP9 and Opus,
 * then VP8 and Opus. A container asked for keeps only its own.
 *
 * @internal
 */
export function exportCandidates(
  output: VideoPlanOutput,
  container?: VideoExportContainer,
): readonly ExportCandidate[] {
  const avc = { codec: h264Codec(output), muxer: "avc" } as const;
  const aac = { codec: "mp4a.40.2", muxer: "aac" } as const;
  const opus = { codec: "opus", muxer: "opus" } as const;
  const all: ExportCandidate[] = [
    { container: "mp4", video: avc, audio: aac },
    { container: "mp4", video: avc, audio: opus },
    { container: "webm", video: { codec: vp9Codec(output), muxer: "vp9" }, audio: opus },
    { container: "webm", video: { codec: "vp8", muxer: "vp8" }, audio: opus },
  ];
  return container ? all.filter((candidate) => candidate.container === container) : all;
}

/** Bits per pixel per frame for each quality (docs/adr/0005): `medium` is about 6 Mbit/s at 1080p30. */
const BITS_PER_PIXEL: Record<VideoExportQuality, number> = { low: 0.05, medium: 0.1, high: 0.2 };
/** Audio bits per second per channel for each quality. */
const AUDIO_BITS_PER_CHANNEL: Record<VideoExportQuality, number> = {
  low: 48_000,
  medium: 64_000,
  high: 96_000,
};

/**
 * The video bitrate for an output at a quality, in bits per second.
 *
 * @internal
 */
export function videoBitrate(output: VideoPlanOutput, quality: VideoExportQuality): number {
  return Math.round(
    output.width * output.height * framesPerSecond(output) * BITS_PER_PIXEL[quality],
  );
}

/**
 * The audio bitrate for an output at a quality, in bits per second.
 *
 * @internal
 */
export function audioBitrate(output: VideoPlanOutput, quality: VideoExportQuality): number {
  return output.channels * AUDIO_BITS_PER_CHANNEL[quality];
}

/**
 * The sample rate an export's audio is encoded at (docs/adr/0001): 48 kHz for
 * Opus, which works at that rate, and the plan's rate for AAC.
 *
 * @internal
 */
export function exportSampleRate(output: VideoPlanOutput, candidate: ExportCandidate): number {
  return candidate.audio.muxer === "opus" ? 48_000 : output.sampleRate;
}

/**
 * Output frames between key frames: every 2 seconds (docs/adr/0005), at least 1.
 *
 * @internal
 */
export function keyFrameInterval(output: VideoPlanOutput): number {
  return Math.max(1, Math.round(2 * framesPerSecond(output)));
}
