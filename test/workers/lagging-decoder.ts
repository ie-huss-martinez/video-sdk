/**
 * A `VideoDecoder` that holds the last `lag` chunks it's given before the real
 * decoder sees them, as Firefox's frame-threaded VP8 decoding does: it
 * outputs nothing until `lag` chunks are in flight, and counts them all in
 * `decodeQueueSize`. Installed in place of the global one, for a test.
 */
export function laggingDecoderClass(lag: number): typeof VideoDecoder {
  const Real = VideoDecoder;
  class LaggingDecoder extends EventTarget {
    readonly #real: VideoDecoder;
    readonly #held: EncodedVideoChunk[] = [];

    constructor(init: VideoDecoderInit) {
      super();
      this.#real = new Real(init);
      this.#real.addEventListener("dequeue", () => this.dispatchEvent(new Event("dequeue")));
    }

    get state(): CodecState {
      return this.#real.state;
    }

    get decodeQueueSize(): number {
      return this.#held.length + this.#real.decodeQueueSize;
    }

    configure(config: VideoDecoderConfig): void {
      this.#real.configure(config);
    }

    decode(chunk: EncodedVideoChunk): void {
      this.#held.push(chunk);
      if (this.#held.length > lag) this.#real.decode(this.#held.shift() as EncodedVideoChunk);
    }

    async flush(): Promise<void> {
      for (const chunk of this.#held.splice(0)) this.#real.decode(chunk);
      await this.#real.flush();
    }

    reset(): void {
      this.#held.length = 0;
      this.#real.reset();
    }

    close(): void {
      this.#held.length = 0;
      this.#real.close();
    }

    static isConfigSupported(config: VideoDecoderConfig) {
      return Real.isConfigSupported(config);
    }
  }
  return LaggingDecoder as unknown as typeof VideoDecoder;
}

/**
 * A `VideoDecoder` that delivers one more frame after it's closed, as an
 * output task the browser queued before `close()` does: Firefox can run one
 * then. The frame is new, from a canvas, so it has to be closed like any.
 * Installed in place of the global one, for a test.
 */
export function lateOutputDecoderClass(): typeof VideoDecoder {
  const Real = VideoDecoder;
  return class LateOutputDecoder extends Real {
    readonly #output: VideoFrameOutputCallback;

    constructor(init: VideoDecoderInit) {
      super(init);
      this.#output = init.output;
    }

    override close(): void {
      super.close();
      const canvas = new OffscreenCanvas(16, 16);
      canvas.getContext("2d")?.fillRect(0, 0, 16, 16);
      setTimeout(() => this.#output(new VideoFrame(canvas, { timestamp: 0 })), 0);
    }
  };
}

/**
 * An `AudioDecoder` that delivers one more chunk after it's closed, as
 * {@link lateOutputDecoderClass} does for video.
 */
export function lateOutputAudioDecoderClass(): typeof AudioDecoder {
  const Real = AudioDecoder;
  return class LateOutputAudioDecoder extends Real {
    readonly #output: AudioDataOutputCallback;

    constructor(init: AudioDecoderInit) {
      super(init);
      this.#output = init.output;
    }

    override close(): void {
      super.close();
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: 48_000,
        numberOfFrames: 128,
        numberOfChannels: 1,
        timestamp: 0,
        data: new Float32Array(128),
      });
      setTimeout(() => this.#output(data), 0);
    }
  };
}
