import type { Composition } from "../../core/playback/compose.js";

/**
 * Paints a composed picture (docs/adr/0006): black outside the output
 * frame, and the picture clipped to it. Playback and export both draw
 * through it, so what plays is what is exported.
 *
 * @internal
 */
export function paint(
  context: OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  composition: Composition,
): void {
  const { canvas } = context;
  const { viewport, source } = composition;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.beginPath();
  context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  context.clip();
  context.translate(composition.centerX, composition.centerY);
  context.rotate((composition.rotation * Math.PI) / 180);
  context.drawImage(
    image,
    source.x,
    source.y,
    source.width,
    source.height,
    -composition.width / 2,
    -composition.height / 2,
    composition.width,
    composition.height,
  );
  context.restore();
}
