import { describe, expect, it } from "vitest";
import { createBitmapDraws } from "./bitmap-draws.js";

/** A frame or bitmap that records whether it's still open. */
class Held {
  open = true;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  close() {
    this.open = false;
  }
}

/** Bitmaps made only when the test says, as from an engine that's slow to make them. */
function slowBitmaps() {
  const pending: {
    frame: Held;
    resolve: (bitmap: Held) => void;
    reject: (error: Error) => void;
  }[] = [];
  const toBitmap = (frame: Held) =>
    new Promise<Held>((resolve, reject) => pending.push({ frame, resolve, reject }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    toBitmap,
    pending,
    /** Makes the oldest bitmap asked for, and lets the draw run. */
    async finish() {
      const next = pending.shift();
      if (!next) throw new Error("no bitmap was asked for");
      const bitmap = new Held(`bitmap of ${next.frame.name}`);
      next.resolve(bitmap);
      await settle();
      return bitmap;
    },
    async fail() {
      pending.shift()?.reject(new Error("refused"));
      await settle();
    },
  };
}

describe("drawing through bitmaps", () => {
  it("holds at most one frame waiting however slow bitmaps are, skipping older ones", async () => {
    const bitmaps = slowBitmaps();
    const draws = createBitmapDraws(bitmaps.toBitmap);
    const drawn: string[] = [];
    const frames = Array.from({ length: 100 }, (_, index) => new Held(`frame ${index}`));
    for (const frame of frames) draws.submit(frame, (bitmap) => drawn.push(bitmap.name));

    // The first is being made into a bitmap, the last waits, and all between were closed.
    expect(bitmaps.pending.map(({ frame }) => frame.name)).toEqual(["frame 0"]);
    expect(frames.filter((frame) => frame.open).map((frame) => frame.name)).toEqual([
      "frame 0",
      "frame 99",
    ]);
    expect(draws.skipped).toBe(98);

    const first = await bitmaps.finish();
    const last = await bitmaps.finish();
    expect(drawn).toEqual(["bitmap of frame 0", "bitmap of frame 99"]);
    expect([first.open, last.open]).toEqual([false, false]);
    expect(frames.some((frame) => frame.open)).toBe(false);
  });

  it("draws every frame, skipping none, when bitmaps keep up", async () => {
    const bitmaps = slowBitmaps();
    const draws = createBitmapDraws(bitmaps.toBitmap);
    const drawn: string[] = [];
    for (const index of [0, 1, 2]) {
      draws.submit(new Held(`frame ${index}`), (bitmap) => drawn.push(bitmap.name));
      await bitmaps.finish();
    }
    expect(drawn).toEqual(["bitmap of frame 0", "bitmap of frame 1", "bitmap of frame 2"]);
    expect(draws.skipped).toBe(0);
  });

  it("closes a frame whose bitmap or draw fails, and draws the next", async () => {
    const bitmaps = slowBitmaps();
    const draws = createBitmapDraws(bitmaps.toBitmap);
    const drawn: string[] = [];
    const refused = new Held("refused");
    draws.submit(refused, () => drawn.push("refused"));
    await bitmaps.fail();
    expect(refused.open).toBe(false);

    const throwing = new Held("throwing");
    draws.submit(throwing, () => {
      throw new Error("draw failed");
    });
    const bitmap = await bitmaps.finish();
    expect([throwing.open, bitmap.open]).toEqual([false, false]);

    draws.submit(new Held("next"), (made) => drawn.push(made.name));
    await bitmaps.finish();
    expect(drawn).toEqual(["bitmap of next"]);
  });
});
