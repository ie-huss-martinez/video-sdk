/** Anything that holds memory until it's closed, as a `VideoFrame` or an `ImageBitmap` does. */
interface Closable {
  close(): void;
}

/**
 * Draws through bitmaps, one at a time, keeping at most one frame waiting
 * (docs/adr/0006). A frame submitted while another waits replaces it: the
 * newer frame is the one due, and the older one is closed undrawn and
 * counted as skipped. So however slow making a bitmap is, at most two
 * frames are held: one being drawn and one waiting.
 *
 * @internal
 */
export interface BitmapDraws<F extends Closable, B extends Closable> {
  /** Takes ownership of `frame`, and closes it once it's drawn or skipped. */
  submit(frame: F, draw: (bitmap: B) => void): void;
  /** Frames closed undrawn because a newer one replaced them. */
  readonly skipped: number;
}

/** @internal */
export function createBitmapDraws<F extends Closable, B extends Closable>(
  toBitmap: (frame: F) => Promise<B>,
): BitmapDraws<F, B> {
  let waiting: { frame: F; draw: (bitmap: B) => void } | undefined;
  let drawing = false;
  let skipped = 0;

  const run = async () => {
    drawing = true;
    while (waiting) {
      const { frame, draw } = waiting;
      waiting = undefined;
      try {
        const bitmap = await toBitmap(frame);
        try {
          draw(bitmap);
        } finally {
          bitmap.close();
        }
      } catch {
        // A frame that can't be drawn is skipped; the next one may draw.
      } finally {
        frame.close();
      }
    }
    drawing = false;
  };

  return {
    submit(frame, draw) {
      if (waiting) {
        waiting.frame.close();
        skipped += 1;
      }
      waiting = { frame, draw };
      if (!drawing) void run();
    },
    get skipped() {
      return skipped;
    },
  };
}
