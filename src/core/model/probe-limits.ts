import { isVideoError, VideoError } from "../errors/video-error.js";
import type { VideoFilePolicy, VideoLimitName } from "../errors/video-limits.js";
import { planFrames, type VideoPlan, type VideoPlanOutput } from "./plan.js";
import type { VideoProbe } from "./source.js";
import { frameTime } from "./time.js";
import { limitWarning, type VideoLimitWarning } from "./warnings.js";

/** Decoded frames waiting to be drawn or encoded (ADR 0002). */
const QUEUED_FRAMES = 4;
/** The most reference frames a decoder may keep: H.264's maximum (ADR 0004). */
const REFERENCE_FRAMES = 16;
/** The frame on the canvas. */
const SHOWN_FRAMES = 1;
/** One window of decoded audio, in seconds (ADR 0005). */
const AUDIO_WINDOW_SECONDS = 0.25;

/**
 * How far a decoded frame's coded size may exceed the probe's, in pixels in
 * each dimension (ADR 0001). Decoders pad frames to their own alignment:
 * Chromium measured 1280 × 738 for H.264 and 1344 × 720 for VP9, both
 * showing 1280 × 720. The decoder refuses frames padded further, and
 * {@link decodingBound} counts this much, so the limit describes what
 * decoders really allocate.
 *
 * @internal
 */
export const CODED_PADDING = 128;

/**
 * The most bytes decoding one file can hold at once, from its probe
 * (ADR 0004): the queued, reference and shown frames as RGBA at the coded
 * size plus the most padding a decoder may add in each dimension, and one
 * window of 32-bit float audio. It bounds memory, not the file's total
 * decoded size, because decoded media is streamed.
 *
 * @public
 */
export function decodingBound(probe: VideoProbe): number {
  const frames = QUEUED_FRAMES + REFERENCE_FRAMES + SHOWN_FRAMES;
  const width = probe.video.codedWidth + CODED_PADDING;
  const height = probe.video.codedHeight + CODED_PADDING;
  const video = frames * width * height * 4;
  const audio =
    probe.audio === null
      ? 0
      : Math.ceil(probe.audio.sampleRate * AUDIO_WINDOW_SECONDS) * probe.audio.channels * 4;
  return video + audio;
}

/**
 * Checks a probe against every limit that applies to one file (ADR 0004),
 * before anything decodes it. Throws `VideoError` with the limit's code on
 * the first one exceeded, and returns a warning for each limit at or above
 * its warning threshold, with the value it found.
 *
 * `maxFileSize` is checked on the file itself, with `checkFile`, and
 * `maxFiles`, `maxSessionSize` and `maxClips` by the session.
 *
 * @public
 */
export function checkProbe(
  policy: VideoFilePolicy,
  probe: VideoProbe,
): readonly VideoLimitWarning[] {
  const checks: readonly (readonly [VideoLimitName, number])[] = [
    ["maxIndexSize", probe.indexSize],
    ["maxTracks", probe.tracks],
    ["maxFramePixels", probe.video.codedWidth * probe.video.codedHeight],
    ["maxFrameRate", probe.video.frameRate],
    ["maxDuration", Math.ceil(probe.duration / 1_000)],
    ["maxBitrate", probe.peakBitrate],
    ["maxPacketSize", probe.maxPacketSize],
    ...(probe.audio === null
      ? []
      : ([
          ["maxChannels", probe.audio.channels],
          ["maxSampleRate", probe.audio.sampleRate],
        ] as const)),
    ["maxDecodedSize", decodingBound(probe)],
  ];
  const warnings: VideoLimitWarning[] = [];
  for (const [limit, actual] of checks) {
    if (policy.check(limit, actual) === "warning") warnings.push(limitWarning(limit, actual));
  }
  return warnings;
}

/**
 * Runs a limit check whose subject isn't a file, and adds `reason` to the
 * `details` of the `VideoError` it throws, so its text can say what was
 * over the limit: the output, or the edited video's length, rather than a
 * file the user opened (ADR 0004).
 */
function checkingFor<T>(reason: string, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (!isVideoError(error)) throw error;
    throw new VideoError(error.code, error.message, {
      details: { ...error.details, reason },
    });
  }
}

/**
 * Checks an output against the limits that apply to what an export encodes
 * (ADR 0004): its frame size, frame rate, channels and sample rate. Throws
 * `VideoError` with the limit's code on the first one exceeded, with
 * `details.reason` `"output"`, and returns a warning for each limit at or
 * above its warning threshold.
 *
 * @public
 */
export function checkOutput(
  policy: VideoFilePolicy,
  output: VideoPlanOutput,
): readonly VideoLimitWarning[] {
  const checks: readonly (readonly [VideoLimitName, number])[] = [
    ["maxFramePixels", output.width * output.height],
    ["maxFrameRate", output.frameRate.num / output.frameRate.den],
    ["maxChannels", output.channels],
    ["maxSampleRate", output.sampleRate],
  ];
  const warnings: VideoLimitWarning[] = [];
  checkingFor("output", () => {
    for (const [limit, actual] of checks) {
      if (policy.check(limit, actual) === "warning") warnings.push(limitWarning(limit, actual));
    }
  });
  return warnings;
}

/**
 * Checks a plan's length against `maxDuration` (ADR 0004). Throws
 * `DURATION_TOO_LONG` over it, with `details.reason` `"plan-too-long"`, and
 * returns its warning when it's at or above the threshold.
 *
 * @public
 */
export function checkPlanLength(
  policy: VideoFilePolicy,
  plan: VideoPlan,
): VideoLimitWarning | undefined {
  const milliseconds = Math.ceil(frameTime(planFrames(plan), plan.output.frameRate) / 1_000);
  const result = checkingFor("plan-too-long", () => policy.check("maxDuration", milliseconds));
  return result === "warning" ? limitWarning("maxDuration", milliseconds) : undefined;
}
