import { createMessages } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { VideoError } from "../core/errors/video-error.js";
import type { VideoLimitName } from "../core/errors/video-limits.js";
import { videoLimitDefinitions, videoLimits } from "../core/errors/video-limits.js";
import { createPlan, IDENTITY_TRANSFORM, NO_FADE } from "../core/model/plan.js";
import { checkOutput, checkPlanLength } from "../core/model/probe-limits.js";
import { videoMessages } from "./en.js";
import { videoErrorText, videoWarningText } from "./text.js";

describe("an error's text", () => {
  const messages = createMessages(videoMessages, { locale: "en" });
  const thrown = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected it to throw");
  };
  const { output } = createPlan({
    width: 1_920,
    height: 1_080,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48_000,
    channels: 2,
  });

  it("says an output over a limit is the output, not a video the user opened", () => {
    const policy = videoLimits.resolve({ maxFramePixels: 1_920 * 1_080, maxFrameRate: 60 });
    const tooLarge = thrown(() => checkOutput(policy, { ...output, width: 3_840, height: 2_160 }));
    expect(videoErrorText(messages, tooLarge)).toBe(
      "That output size has 8,294,400 pixels, which is more than the 2,073,600 a picture can have. Choose a smaller size.",
    );
    const tooFast = thrown(() =>
      checkOutput(policy, { ...output, frameRate: { num: 120, den: 1 } }),
    );
    expect(videoErrorText(messages, tooFast)).toBe(
      "That output has 120 frames per second, which is more than the limit of 60.",
    );
    // The code's own text is about the file, which isn't what was refused.
    expect(messages.error(tooLarge)).toContain("This video's picture");
  });

  it("says an edit would make the video too long, rather than a file is", () => {
    const policy = videoLimits.resolve({ maxDuration: 60_000 });
    const clip = {
      key: "a",
      source: "source-1",
      start: 0,
      end: 90_000_000,
      volumeDb: 0,
      muted: false,
      fadeIn: NO_FADE,
      fadeOut: NO_FADE,
      transform: IDENTITY_TRANSFORM,
    };
    const long = thrown(() => checkPlanLength(policy, { ...createPlan(output), clips: [clip] }));
    expect(videoErrorText(messages, long)).toBe(
      "This would make the video 1 min, 30 sec long, which is over the 1 min limit.",
    );
  });

  it("falls back to the code's text without a reason, or with one it has no text for", () => {
    const plain = new VideoError("BUSY", "busy");
    expect(videoErrorText(messages, plain)).toBe(messages.error(plain));
    const unknown = new VideoError("FRAME_TOO_LARGE", "x", {
      details: { reason: "not-a-reason", actual: 1, maximum: 1 },
    });
    expect(videoErrorText(messages, unknown)).toBe(messages.error(unknown));
    expect(videoErrorText(messages, new Error("not ours"))).toBe(
      messages.error(new Error("not ours")),
    );
  });
});

describe("a warning's text", () => {
  const messages = createMessages(videoMessages, { locale: "en" });

  it("is the limit's text, with its value", () => {
    expect(videoWarningText(messages, { type: "limit", limit: "maxFrameRate", actual: 90 })).toBe(
      "This video has 90 frames per second, and may play slowly on some devices.",
    );
    expect(
      videoWarningText(messages, {
        type: "limit",
        limit: "maxDuration",
        actual: 4_000_000,
        source: "source-1",
      }),
    ).toBe("This video is long, and may be slow to open and save.");
  });

  it("says a video opened without its sound", () => {
    expect(
      videoWarningText(messages, {
        type: "audioUndecodable",
        source: "source-1",
        codec: "mp4a.40.2",
      }),
    ).toContain("opened without sound");
  });

  it("has text for every limit", () => {
    for (const limit of Object.keys(videoLimitDefinitions) as VideoLimitName[]) {
      const text = videoWarningText(messages, { type: "limit", limit, actual: 1 });
      expect(text, limit).not.toContain("warnings.");
      expect(text.length, limit).toBeGreaterThan(0);
    }
  });
});
