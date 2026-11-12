/**
 * The containers the front check recognises (ADR 0001).
 *
 * @public
 */
export type VideoContainer = "mp4" | "mov" | "webm" | "mkv";

/**
 * A quarter turn, in degrees clockwise.
 *
 * @public
 */
export type VideoRotation = 0 | 90 | 180 | 270;

/**
 * What the probe learned about a file's video track before anything decodes
 * it (ADR 0001).
 *
 * @public
 */
export interface VideoTrackProbe {
  /** The codec, as a WebCodecs codec string, such as `"avc1.64001f"`. */
  readonly codec: string;
  /** The size the decoder produces, which every decoded frame is checked against. */
  readonly codedWidth: number;
  readonly codedHeight: number;
  /** The size the picture is shown at, before rotation. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** The rotation the container asks for, which is always applied. */
  readonly rotation: VideoRotation;
  /** The most frames in any one-second window of the packet walk (ADR 0004). */
  readonly frameRate: number;
  /** How many packets the walk found. */
  readonly packets: number;
}

/**
 * What the probe learned about a file's audio track (ADR 0001).
 *
 * @public
 */
export interface AudioTrackProbe {
  /** The codec, as a WebCodecs codec string, such as `"mp4a.40.2"` or `"opus"`. */
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * What the front check and the packet walk learned about a file, before
 * anything decodes it (ADR 0001, ADR 0004). Every limit except the
 * session's is checked against it.
 *
 * @public
 */
export interface VideoProbe {
  readonly container: VideoContainer;
  /**
   * Where the source's time begins, in the container's microseconds: the
   * video track's earliest presentation timestamp. Source times in the plan,
   * video frame bounds and waveform buckets all count from it, so a file
   * whose timestamps don't start at 0 stays in sync (ADR 0003). Audio before
   * it, such as Opus's codec delay, is pre-roll, and isn't played.
   */
  readonly start: number;
  /**
   * The length in microseconds, from `start`: the larger of what the header
   * claims and what the packet walk found, so a header can't lower it.
   */
  readonly duration: number;
  /** Every track in the file, of every kind, including those not used. */
  readonly tracks: number;
  /** The size of the file's index, in bytes, from the front check. */
  readonly indexSize: number;
  /** The highest bitrate over any one-second window, in bits per second. */
  readonly peakBitrate: number;
  /** The largest packet, in bytes. */
  readonly maxPacketSize: number;
  readonly video: VideoTrackProbe;
  /** The audio track the SDK uses, or `null` when the file has none it can decode. */
  readonly audio: AudioTrackProbe | null;
}

/**
 * A source the session holds, without its data: what the snapshot shows and
 * what commands are checked against (ADR 0003).
 *
 * @public
 */
export interface VideoSourceInfo {
  readonly id: string;
  readonly container: VideoContainer;
  /** The length in microseconds. */
  readonly duration: number;
  readonly video: {
    readonly codec: string;
    /** The display size, before rotation. */
    readonly width: number;
    readonly height: number;
    readonly rotation: VideoRotation;
    /** Frames per second, as the probe measured them. */
    readonly frameRate: number;
  };
  readonly audio: AudioTrackProbe | null;
}

/**
 * A source's summary for the session, from its id and its probe.
 *
 * @public
 */
export function sourceInfo(id: string, probe: VideoProbe): VideoSourceInfo {
  return {
    id,
    container: probe.container,
    duration: probe.duration,
    video: {
      codec: probe.video.codec,
      width: probe.video.displayWidth,
      height: probe.video.displayHeight,
      rotation: probe.video.rotation,
      frameRate: probe.video.frameRate,
    },
    audio: probe.audio,
  };
}

/**
 * Turns a size by a rotation: width and height swap for a quarter turn.
 *
 * @public
 */
export function rotateSize(
  size: { readonly width: number; readonly height: number },
  rotation: VideoRotation,
): { readonly width: number; readonly height: number } {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * Adds two rotations.
 *
 * @public
 */
export function addRotations(a: VideoRotation, b: VideoRotation): VideoRotation {
  return ((a + b) % 360) as VideoRotation;
}

/**
 * A source's waveform overview: the lowest and highest sample of each bucket
 * of time, across all channels, so that drawing a waveform never decodes
 * audio again (docs/adr/0002). Bucket `i` covers the source's time from
 * `i × bucketDuration` microseconds, counted from the probe's `start`.
 * Samples are clamped to [-1, 1], so a waveform always fits its lane even
 * when decoded audio goes over full scale, and samples that aren't numbers
 * are left out.
 *
 * @public
 */
export interface VideoPeaks {
  /** How long each bucket is, in microseconds. */
  readonly bucketDuration: number;
  readonly min: Float32Array;
  readonly max: Float32Array;
}
