import { describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM } from "../model/plan.js";
import { composeFrame } from "./compose.js";

const HD = { width: 1280, height: 720 };

describe("composing a frame", () => {
  it("draws the whole frame over the whole output when sizes match", () => {
    expect(composeFrame(HD, HD, { ...HD, rotation: 0 }, IDENTITY_TRANSFORM)).toEqual({
      viewport: { x: 0, y: 0, width: 1280, height: 720 },
      source: { x: 0, y: 0, width: 1280, height: 720 },
      centerX: 640,
      centerY: 360,
      width: 1280,
      height: 720,
      rotation: 0,
    });
  });

  it("letterboxes the output in a surface of another shape", () => {
    const { viewport } = composeFrame(
      HD,
      { width: 640, height: 640 },
      { ...HD, rotation: 0 },
      IDENTITY_TRANSFORM,
    );
    expect(viewport).toEqual({ x: 0, y: 140, width: 640, height: 360 });
  });

  it("fits a portrait picture in a landscape output: contain pillarboxes, cover cuts", () => {
    const portrait = { width: 720, height: 1280, rotation: 0 } as const;
    const contain = composeFrame(HD, HD, portrait, IDENTITY_TRANSFORM);
    expect([contain.width, contain.height]).toEqual([405, 720]);
    const cover = composeFrame(HD, HD, portrait, { ...IDENTITY_TRANSFORM, fit: "cover" });
    expect([cover.width, cover.height]).toEqual([1280, 1280 * (1280 / 720)]);
  });

  it("turns the picture by the source's rotation plus the clip's", () => {
    // Stored landscape, shown a quarter turn clockwise: portrait, pillarboxed.
    const turned = composeFrame(HD, HD, { ...HD, rotation: 90 }, IDENTITY_TRANSFORM);
    expect(turned.rotation).toBe(90);
    // Before turning, the picture is 720 × 405 on the surface: 405 × 720 once turned.
    expect([turned.width, turned.height]).toEqual([720, 405]);
    const back = composeFrame(
      HD,
      HD,
      { ...HD, rotation: 90 },
      {
        ...IDENTITY_TRANSFORM,
        rotation: 270,
      },
    );
    expect(back.rotation).toBe(0);
  });

  it.each([
    // The left half of the picture as shown, at each rotation of a 1280 × 720 source.
    [0, { x: 0, y: 0, width: 640, height: 720 }],
    [180, { x: 640, y: 0, width: 640, height: 720 }],
  ] as const)(
    "maps a crop in the picture as shown back to the source, at %i°",
    (rotation, expected) => {
      const crop = { x: 0, y: 0, width: 640, height: 720 };
      const { source } = composeFrame(HD, HD, { ...HD, rotation }, { ...IDENTITY_TRANSFORM, crop });
      expect(source).toEqual(expected);
    },
  );

  it.each([
    // The top-left quarter of the picture as shown, which is 720 × 1280.
    [90, { x: 0, y: 360, width: 640, height: 360 }],
    [270, { x: 640, y: 0, width: 640, height: 360 }],
  ] as const)("maps a crop through a quarter turn, at %i°", (rotation, expected) => {
    const crop = { x: 0, y: 0, width: 360, height: 640 };
    const { source } = composeFrame(HD, HD, { ...HD, rotation }, { ...IDENTITY_TRANSFORM, crop });
    expect(source).toEqual(expected);
  });
});
