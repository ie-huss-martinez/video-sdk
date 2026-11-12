// Which codecs this browser can export and read back here (docs/adr/0005).

/**
 * Whether this browser can encode `codec` here, and then decode what it
 * encoded: one black frame, encoded and decoded back.
 */
async function roundTrip(codec: string): Promise<"ok" | "no-encode" | "no-decode"> {
  const config = { codec, width: 256, height: 32, bitrate: 500_000, framerate: 30 };
  try {
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return "no-encode";
  } catch {
    return "no-encode";
  }
  let chunk: EncodedVideoChunk | undefined;
  let decoderConfig: VideoDecoderConfig | undefined;
  const encoder = new VideoEncoder({
    output: (encoded, meta) => {
      chunk ??= encoded;
      decoderConfig ??= meta?.decoderConfig;
    },
    error: () => {},
  });
  try {
    encoder.configure(config);
    const canvas = new OffscreenCanvas(256, 32);
    (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).fillRect(0, 0, 256, 32);
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
  } catch {
    return "no-encode";
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (!chunk || !decoderConfig) return "no-encode";
  let decoded = false;
  const decoder = new VideoDecoder({
    output: (frame) => {
      decoded = true;
      frame.close();
    },
    error: () => {},
  });
  try {
    decoder.configure(decoderConfig);
    decoder.decode(chunk);
    await decoder.flush();
  } catch {
    return "no-decode";
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  return decoded ? "ok" : "no-decode";
}

/**
 * Why an export in `container` can't be read back in this browser here, or
 * `undefined` when it can: the video codec the processor would choose, the
 * first it can encode, must also decode. WebKit with a host's GStreamer may
 * encode codecs it can't decode; the pinned image's WebKit decodes them all.
 */
export async function unreadable(container?: "webm"): Promise<string | undefined> {
  const codecs =
    container === "webm" ? ["vp09.00.10.08", "vp8"] : ["avc1.64000c", "vp09.00.10.08", "vp8"];
  for (const codec of codecs) {
    const result = await roundTrip(codec);
    if (result === "ok") return undefined;
    if (result === "no-decode") {
      return `this browser exports ${codec} here but can't decode it back (WebKit with the host's GStreamer)`;
    }
  }
  return "this browser encodes none of the export's video codecs here";
}
