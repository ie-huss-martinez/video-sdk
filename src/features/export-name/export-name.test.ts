import { MAX_FILE_NAME_LENGTH } from "@hussmartinez/sdk-core";
import { describe, expect, it } from "vitest";
import { exportFileName } from "./export-name.js";

// The cleaning itself is sdk-core's cleanFileName, tested there; these are
// the steps video adds after it, and that it's the family's cleaning.
describe("the export's file name", () => {
  it("is the host's name, else the title, else video", () => {
    expect(exportFileName("Holiday", "Take 1")).toBe("Holiday");
    expect(exportFileName(undefined, "Take 1")).toBe("Take 1");
    expect(exportFileName("", "")).toBe("video");
    expect(exportFileName("  ", "...")).toBe("video");
    // A name that cleans to nothing falls back too.
    expect(exportFileName("\u202e", "Take 1")).toBe("Take 1");
  });

  it("is cleaned as the family cleans a file name: the last path segment", () => {
    expect(exportFileName("Holiday/day 1.mov", "")).toBe("day 1");
    expect(exportFileName("C:\\Users\\me\\clip.mp4", "")).toBe("clip");
  });

  it("drops a video extension the host left on, as the export adds its own", () => {
    expect(exportFileName("holiday.MOV", "")).toBe("holiday");
    expect(exportFileName("clip.final.webm", "")).toBe("clip.final");
    expect(exportFileName("notes.txt", "")).toBe("notes.txt");
    // What's left is cleaned again: no trailing space, and nothing left is none.
    expect(exportFileName("holiday .mkv", "")).toBe("holiday");
    expect(exportFileName("x/.mp4", "Take 1")).toBe("mp4");
  });

  it("cleans the title as it cleans a name", () => {
    expect(exportFileName(undefined, 'Take 1: "the beach"')).toBe("Take 1 the beach");
    expect([...exportFileName(undefined, "🎬".repeat(200))]).toHaveLength(MAX_FILE_NAME_LENGTH);
  });

  it("drops a lone surrogate, which no file system can store, and keeps a whole pair", () => {
    // Half of a pair, as a name cut mid-character arrives: written out, it
    // would fail or turn into a replacement character.
    expect(exportFileName("clip\uD83C.mp4", "")).toBe("clip");
    expect(exportFileName("\uDFAC", "Take 1")).toBe("Take 1");
    expect(exportFileName("clip \uD83C\uDFAC.mp4", "")).toBe("clip \uD83C\uDFAC");
  });
});
