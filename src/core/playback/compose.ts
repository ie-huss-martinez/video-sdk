import type { VideoPlanOutput, VideoTransform } from "../model/plan.js";
import { addRotations, rotateSize, type VideoRotation } from "../model/source.js";

/** A rectangle in pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How one clip's frame is drawn (docs/adr/0006), as plain numbers, so that
 * playback and export compose the same way.
 *
 * @internal
 */
export interface Composition {
  /** Where the output frame sits on the surface, letterboxed. Outside it is black. */
  readonly viewport: Rect;
  /** The part of the frame to draw, in its own pixels before any rotation. */
  readonly source: Rect;
  /** Where the picture's centre is on the surface. */
  readonly centerX: number;
  readonly centerY: number;
  /** The picture's size on the surface before it's turned by `rotation`. */
  readonly width: number;
  readonly height: number;
  /** How far to turn the picture, clockwise: the source's rotation plus the clip's. */
  readonly rotation: VideoRotation;
}

/**
 * The part of an unrotated picture of `width × height` that shows as `rect`
 * once turned clockwise by `rotation`.
 */
function unrotate(rect: Rect, width: number, height: number, rotation: VideoRotation): Rect {
  const { x, y, width: w, height: h } = rect;
  switch (rotation) {
    case 90:
      return { x: y, y: height - x - w, width: h, height: w };
    case 180:
      return { x: width - x - w, y: height - y - h, width: w, height: h };
    case 270:
      return { x: width - y - h, y: x, width: h, height: w };
    default:
      return { x, y, width: w, height: h };
  }
}

/**
 * Composes a clip's frame onto a surface (docs/adr/0006): the output frame is
 * letterboxed into the surface; the frame is turned by the source's rotation
 * and the clip's, cut to the clip's crop, which is in pixels of the picture
 * as shown, and fitted into the output frame by the clip's fit, centred.
 * `cover` overflows the output frame, so the drawing must be clipped to the
 * viewport.
 *
 * @param output - The plan's output.
 * @param surface - The size drawn into, such as the stage times the device pixel ratio.
 * @param source - The source's display size before rotation, and its own rotation.
 * @param transform - The clip's transform.
 * @internal
 */
export function composeFrame(
  output: Pick<VideoPlanOutput, "width" | "height">,
  surface: { readonly width: number; readonly height: number },
  source: { readonly width: number; readonly height: number; readonly rotation: VideoRotation },
  transform: VideoTransform,
): Composition {
  const rotation = addRotations(source.rotation, transform.rotation);
  const shown = rotateSize(source, rotation);
  const crop = transform.crop ?? { x: 0, y: 0, width: shown.width, height: shown.height };

  const scale = Math.min(surface.width / output.width, surface.height / output.height);
  const viewport = {
    x: (surface.width - output.width * scale) / 2,
    y: (surface.height - output.height * scale) / 2,
    width: output.width * scale,
    height: output.height * scale,
  };
  const fit = transform.fit === "cover" ? Math.max : Math.min;
  const picture = fit(viewport.width / crop.width, viewport.height / crop.height);
  const turned = rotateSize(
    { width: crop.width * picture, height: crop.height * picture },
    rotation,
  );
  return {
    viewport,
    source: unrotate(crop, source.width, source.height, rotation),
    centerX: viewport.x + viewport.width / 2,
    centerY: viewport.y + viewport.height / 2,
    width: turned.width,
    height: turned.height,
    rotation,
  };
}
