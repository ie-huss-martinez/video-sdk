import {
  BlobSource,
  Input,
  type InputAudioTrack,
  type InputFormat,
  type InputTrack,
  type InputVideoTrack,
  MATROSKA,
  MP4,
  QTFF,
  WEBM,
} from "mediabunny";
import { VideoError } from "../../core/errors/video-error.js";
import type { VideoContainer } from "../../core/model/source.js";
import type { FrontCheck } from "../front-check/types.js";

/** The only formats mediabunny is given, per family: never `ALL_FORMATS` (ADR 0001). */
const FORMATS: Record<FrontCheck["family"], InputFormat[]> = {
  isobmff: [MP4, QTFF],
  matroska: [MATROSKA, WEBM],
};

/** The family of mediabunny's readers that reads a container. */
export function familyOf(container: VideoContainer): FrontCheck["family"] {
  return container === "mp4" || container === "mov" ? "isobmff" : "matroska";
}

/**
 * Opens a front-checked file with mediabunny, restricted to its family's
 * formats. The caller disposes of it.
 */
export function openInput(file: Blob, family: FrontCheck["family"]): Input {
  return new Input({ source: new BlobSource(file), formats: FORMATS[family] });
}

/** A track's codec as a WebCodecs codec string, or mediabunny's name for it. */
export async function codecOf(track: InputTrack): Promise<string | null> {
  return (await track.getCodecParameterString()) ?? (await track.getCodec());
}

/**
 * The tracks the SDK uses (ADR 0001): the primary video track, or the first;
 * and the first audio track whose codec mediabunny recognises. The probe and
 * every later reader pick the same ones.
 *
 * Throws `VideoError`: `UNSUPPORTED_FORMAT` for no video track or a mirrored
 * one, and `UNSUPPORTED_CODEC` for a video codec mediabunny doesn't know.
 */
export async function pickTracks(
  input: Input,
  container: VideoContainer,
): Promise<{ video: InputVideoTrack; videoCodec: string; audio: InputAudioTrack | undefined }> {
  const video = (await input.getPrimaryVideoTrack()) ?? (await input.getVideoTracks())[0];
  if (!video) {
    throw new VideoError("UNSUPPORTED_FORMAT", "The file has no video track.", {
      details: { container, reason: "no-video" },
    });
  }
  if (await video.getFlip()) {
    throw new VideoError("UNSUPPORTED_FORMAT", "The video track is mirrored.", {
      details: { container, reason: "flip" },
    });
  }
  const videoCodec = await codecOf(video);
  if (videoCodec === null) {
    throw new VideoError("UNSUPPORTED_CODEC", "The video codec isn't recognised.", {
      details: { container },
    });
  }
  for (const track of await input.getAudioTracks()) {
    if ((await codecOf(track)) !== null) return { video, videoCodec, audio: track };
  }
  return { video, videoCodec, audio: undefined };
}
