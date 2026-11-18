import { createMessages } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import type { VideoLimitName } from "../core/errors/video-limits.js";
import { videoLimitDefinitions } from "../core/errors/video-limits.js";
import { videoMessages } from "./en.js";
import { videoWarningText } from "./text.js";

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
