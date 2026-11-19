/**
 * How long a flush may go without output or a `dequeue` before the codec is
 * taken to have stopped, in milliseconds (docs/adr/0002). A flush works
 * through what's still queued, each item in far less; one that gives
 * nothing back for this long never will.
 */
export const FLUSH_STALL_TIMEOUT = 2_000;

/** How often a bounded flush checks whether its codec has gone quiet, in milliseconds. */
const QUIET_CHECK = 50;

/**
 * A WebCodecs encoder's or decoder's `flush()`, bounded (docs/adr/0002): it
 * settles as the flush does, or rejects with `stalled()` once the codec has
 * given back neither output nor a `dequeue` for {@link FLUSH_STALL_TIMEOUT}.
 * `heard` says when the caller last saw output; a `dequeue` counts too. A
 * codec that stopped altogether never settles its flush, and the caller
 * would wait forever.
 */
export function boundedFlush(
  codec: EventTarget & { flush(): Promise<void> },
  heard: () => number,
  stalled: () => Error,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let dequeued = performance.now();
    const onDequeue = () => {
      dequeued = performance.now();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      codec.removeEventListener("dequeue", onDequeue);
    };
    const watch = () => {
      timer = setTimeout(() => {
        if (performance.now() - Math.max(heard(), dequeued) < FLUSH_STALL_TIMEOUT) return watch();
        settle();
        reject(stalled());
      }, QUIET_CHECK);
    };
    codec.addEventListener("dequeue", onDequeue);
    watch();
    codec.flush().then(
      () => {
        settle();
        resolve();
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}
