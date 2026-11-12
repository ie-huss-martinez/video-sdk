import type { VideoFilePolicy } from "../errors/video-limits.js";
import { backingSize } from "../ports/video-output.js";

/**
 * The backing size for `VideoOutput.resize`, checked (docs/adr/0006): a size
 * and ratio that aren't positive finite numbers are a `TypeError`, and a
 * backing size over `maxFramePixels` throws `FRAME_TOO_LARGE`, so a runaway
 * layout can't size the canvas past the limits.
 *
 * @internal
 */
export function checkedBackingSize(
  policy: VideoFilePolicy,
  width: number,
  height: number,
  pixelRatio = 1,
): { readonly width: number; readonly height: number } {
  for (const value of [width, height, pixelRatio]) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new TypeError("A size and pixel ratio must be positive finite numbers.");
    }
  }
  const size = backingSize(width, height, pixelRatio);
  policy.check("maxFramePixels", size.width * size.height);
  return size;
}
