/**
 * A `VideoDecoder` that holds the last `lag` chunks it's given before the real
 * decoder sees them, as Firefox's frame-threaded VP8 decoding does: it
 * outputs nothing until `lag` chunks are in flight, and counts them all in
 * `decodeQueueSize`. Installed in place of the global one, for a test.
 */
/** How many stand-in video decoders have been closed, so tests can see nothing keeps running. */
export const standInsClosed = { video: 0 };

/**
 * With `mode`: `"stuck"`, a decoder that gives nothing back and whose flush
 * never settles, as one that stopped; `"pool"`, one whose flush settles only
 * once every frame it gave back has been closed, as a decoder with a fixed
 * pool of frames waits for them.
 */
export function laggingDecoderClass(
  lag: number,
  burst = false,
  mode?: "stuck" | "pool",
): typeof VideoDecoder {
  const Real = VideoDecoder;
  class LaggingDecoder extends EventTarget {
    readonly #real: VideoDecoder;
    readonly #held: EncodedVideoChunk[] = [];
    readonly #output: VideoFrameOutputCallback;

    readonly #given: VideoFrame[] = [];

    constructor(init: VideoDecoderInit) {
      super();
      this.#output = init.output;
      this.#real = new Real({
        ...init,
        output: (frame) => {
          this.#given.push(frame);
          init.output(frame);
        },
      });
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
      // A burst: once the queue is full, four frames come at once, on a task,
      // while the queue still counts every packet held.
      if (burst && this.#held.length === lag) {
        const times = this.#held.slice(0, 4).map((held) => held.timestamp);
        setTimeout(() => {
          for (const timestamp of times) {
            const canvas = new OffscreenCanvas(16, 16);
            canvas.getContext("2d")?.fillRect(0, 0, 16, 16);
            this.#output(new VideoFrame(canvas, { timestamp }));
          }
        }, 0);
      }
      if (mode !== "stuck" && this.#held.length > lag) {
        this.#real.decode(this.#held.shift() as EncodedVideoChunk);
      }
    }

    async flush(): Promise<void> {
      if (mode === "stuck") return new Promise(() => {});
      for (const chunk of this.#held.splice(0)) this.#real.decode(chunk);
      await this.#real.flush();
      // A closed frame has no format.
      while (mode === "pool" && this.#given.some((frame) => frame.format !== null)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    reset(): void {
      this.#held.length = 0;
      this.#real.reset();
    }

    close(): void {
      this.#held.length = 0;
      standInsClosed.video += 1;
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

/**
 * An `AudioDecoder` that holds the last `lag` chunks it's given before the
 * real decoder sees them, and counts them in `decodeQueueSize`, so it
 * outputs nothing until `lag` chunks are in flight; and, with `dequeue:
 * false`, one that never fires `dequeue`, as a browser without the event
 * would; and, with `stuck`, one that never gives anything back, whose flush
 * never settles, as a decoder that stopped: for every codec, or only the
 * codec named. Each leaves a decode loop
 * without a stall guard waiting forever.
 */
export function laggingAudioDecoderClass(
  lag: number,
  dequeue = true,
  stuck: boolean | string = false,
  burst = false,
): typeof AudioDecoder {
  const Real = AudioDecoder;
  class LaggingAudioDecoder extends EventTarget {
    readonly #real: AudioDecoder;
    readonly #held: EncodedAudioChunk[] = [];
    #stuck = stuck === true;
    readonly #output: AudioDataOutputCallback;
    #config: AudioDecoderConfig | undefined;

    constructor(init: AudioDecoderInit) {
      super();
      this.#output = init.output;
      this.#real = new Real(init);
      if (dequeue) {
        this.#real.addEventListener("dequeue", () => this.dispatchEvent(new Event("dequeue")));
      }
    }

    get state(): CodecState {
      return this.#real.state;
    }

    get decodeQueueSize(): number {
      return this.#held.length + this.#real.decodeQueueSize;
    }

    configure(config: AudioDecoderConfig): void {
      if (typeof stuck === "string") this.#stuck = config.codec === stuck;
      this.#config = config;
      this.#real.configure(config);
    }

    decode(chunk: EncodedAudioChunk): void {
      this.#held.push(chunk);
      // A burst: once the queue is full, four chunks come at once, on a task,
      // while the queue still counts every packet held.
      const config = this.#config;
      if (burst && config && this.#held.length === lag) {
        const times = this.#held.slice(0, 4).map((held) => held.timestamp);
        setTimeout(() => {
          for (const timestamp of times) {
            this.#output(
              new AudioData({
                format: "f32-planar",
                sampleRate: config.sampleRate,
                numberOfFrames: 960,
                numberOfChannels: config.numberOfChannels,
                timestamp,
                data: new Float32Array(960 * config.numberOfChannels),
              }),
            );
          }
        }, 0);
      }
      if (this.#held.length > (this.#stuck ? Number.POSITIVE_INFINITY : lag))
        this.#real.decode(this.#held.shift() as EncodedAudioChunk);
    }

    async flush(): Promise<void> {
      // Stuck: it never gives anything back, and its flush never settles.
      if (this.#stuck) return new Promise(() => {});
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

    static isConfigSupported(config: AudioDecoderConfig) {
      return Real.isConfigSupported(config);
    }
  }
  return LaggingAudioDecoder as unknown as typeof AudioDecoder;
}

/**
 * An `AudioEncoder` that stopped: it takes what it's given and gives nothing
 * back, and its flush never settles. Installed in place of the global one.
 */
export function stuckAudioEncoderClass(): typeof AudioEncoder {
  const Real = AudioEncoder;
  return class StuckAudioEncoder extends Real {
    override encode(_data: AudioData): void {}

    override flush(): Promise<void> {
      return new Promise(() => {});
    }
  };
}

/**
 * A `VideoEncoder` that stopped: it takes what it's given and gives nothing
 * back, and its flush never settles. Installed in place of the global one.
 */
export function stuckVideoEncoderClass(): typeof VideoEncoder {
  const Real = VideoEncoder;
  return class StuckVideoEncoder extends Real {
    override encode(_frame: VideoFrame, _options?: VideoEncoderEncodeOptions): void {}

    override flush(): Promise<void> {
      return new Promise(() => {});
    }
  };
}
