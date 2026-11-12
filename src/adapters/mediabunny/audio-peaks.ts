import type { VideoPeaks, VideoProbe } from "../../core/model/source.js";
import { createPeakBuilder } from "../peaks.js";
import { decodeAudioData } from "./audio-decoder.js";
import { familyOf, openInput, pickTracks } from "./tracks.js";

/**
 * Decodes a probed file's audio track in the worker, and builds its waveform
 * peaks (docs/adr/0002). Every chunk is copied out as 32-bit float samples
 * and closed at once. Resolves `null` for a file without audio.
 *
 * @internal
 */
export async function audioPeaks(
  file: Blob,
  probe: VideoProbe,
  signal?: AbortSignal,
): Promise<VideoPeaks | null> {
  const input = openInput(file, familyOf(probe.container));
  try {
    const { audio } = await pickTracks(input, probe.container);
    const config = audio && (await audio.getDecoderConfig());
    if (!audio || !config) return null;
    const peaks = createPeakBuilder(probe.start, probe.duration);
    let buffers: Float32Array[] = [];
    await decodeAudioData(
      audio,
      config,
      { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
      (data) => {
        if (
          buffers.length !== data.numberOfChannels ||
          (buffers[0]?.length ?? 0) < data.numberOfFrames
        ) {
          buffers = Array.from(
            { length: data.numberOfChannels },
            () => new Float32Array(data.numberOfFrames),
          );
        }
        const channels = buffers.map((buffer, planeIndex) => {
          const view = buffer.subarray(0, data.numberOfFrames);
          data.copyTo(view, { planeIndex, format: "f32-planar" });
          return view;
        });
        peaks.add({
          timestamp: data.timestamp,
          sampleRate: data.sampleRate,
          numberOfFrames: data.numberOfFrames,
          channels,
        });
      },
      signal,
    );
    return peaks.finish();
  } finally {
    input.dispose();
  }
}
