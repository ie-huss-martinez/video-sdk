import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedFlush, FLUSH_STALL_TIMEOUT } from "./bounded-flush.js";

/** A codec whose flush settles when the test says, and fires `dequeue` on demand. */
function fakeCodec() {
  let settle: (error?: Error) => void = () => {};
  const codec = Object.assign(new EventTarget(), {
    flush: () =>
      new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      }),
  });
  return { codec, settle: (error?: Error) => settle(error) };
}

const stalled = () => new Error("stalled");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a bounded flush", () => {
  it("settles as the flush does, and with its error", async () => {
    const ok = fakeCodec();
    const flushed = boundedFlush(ok.codec, () => performance.now(), stalled);
    ok.settle();
    await expect(flushed).resolves.toBeUndefined();
    const failing = fakeCodec();
    const failed = boundedFlush(failing.codec, () => 0, stalled);
    failing.settle(new Error("the codec's own"));
    await expect(failed).rejects.toThrow("the codec's own");
  });

  it("gives up once the codec has given back nothing for the timeout", async () => {
    const { codec } = fakeCodec();
    const heard = performance.now();
    const flushed = boundedFlush(codec, () => heard, stalled);
    const outcome = flushed.then(
      () => "settled",
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(FLUSH_STALL_TIMEOUT - 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toBe("stalled");
  });

  it("waits on while the codec gives back output or a dequeue", async () => {
    const { codec, settle } = fakeCodec();
    let heard = performance.now();
    let outcome = "waiting";
    boundedFlush(codec, () => heard, stalled).then(
      () => {
        outcome = "settled";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    // Output now and then, then a dequeue now and then: never quiet for long.
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(FLUSH_STALL_TIMEOUT - 500);
      heard = performance.now();
    }
    for (let step = 0; step < 4; step += 1) {
      await vi.advanceTimersByTimeAsync(FLUSH_STALL_TIMEOUT - 500);
      codec.dispatchEvent(new Event("dequeue"));
    }
    expect(outcome).toBe("waiting");
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toBe("settled");
  });
});
