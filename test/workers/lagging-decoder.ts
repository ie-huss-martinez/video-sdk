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
