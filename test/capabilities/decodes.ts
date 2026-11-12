// Whether a real file decodes, for the matrix's `decodes` row: video through
// the SDK's own decoder, audio through AudioDecoder over mediabunny's
// packets. A codec that doesn't decode is false, whatever the browser claims.
import { EncodedPacketSink } from "mediabunny";
import { frameBounds } from "../../src/adapters/mediabunny/frame-bounds.js";
import { familyOf, openInput, pickTracks } from "../../src/adapters/mediabunny/tracks.js";
import { decodeVideoFrames } from "../../src/adapters/mediabunny/video-decoder.js";
import { probeFile } from "../../src/adapters/probe.js";
import { videoLimits } from "../../src/core/errors/video-limits.js";

/** How many frames, or audio packets, must decode. */
const SAMPLE = 10;

export async function decodes(file: Blob, track: "video" | "audio"): Promise<boolean> {
  try {
    const probe = await probeFile(file, videoLimits.resolve());
    const input = openInput(file, familyOf(probe.container));
    try {
      const { video, audio } = await pickTracks(input, probe.container);
      if (track === "video") {
        const config = await video.getDecoderConfig();
        if (config === null) return false;
        const range = {
          from: Number.NEGATIVE_INFINITY,
          to: Number.POSITIVE_INFINITY,
          limit: SAMPLE,
        };
        const bounds = frameBounds(probe);
        return (await decodeVideoFrames(video, config, bounds, range, () => {})) === SAMPLE;
      }
      const config = audio && (await audio.getDecoderConfig());
      if (!audio || !config) return false;
      return await decodeAudio(new EncodedPacketSink(audio), config);
    } finally {
      input.dispose();
    }
  } catch {
    return false;
  }
}

async function decodeAudio(sink: EncodedPacketSink, config: AudioDecoderConfig): Promise<boolean> {
  let outputs = 0;
  let failed = false;
  const decoder = new AudioDecoder({
    output(data) {
      outputs += 1;
      data.close();
    },
    error() {
      failed = true;
    },
  });
  try {
    decoder.configure(config);
    let packet = await sink.getFirstPacket();
    for (let count = 0; packet && count < SAMPLE; count += 1) {
      decoder.decode(packet.toEncodedAudioChunk());
      packet = await sink.getNextPacket(packet);
    }
    await decoder.flush();
    return !failed && outputs > 0;
  } catch {
    return false;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
}
