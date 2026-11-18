import { describe, expect, it } from "vitest";
import { exportFileName } from "./export-name.js";

describe("the export's file name", () => {
  it("is the host's name, else the title, else video", () => {
    expect(exportFileName("Holiday", "Take 1")).toBe("Holiday");
    expect(exportFileName(undefined, "Take 1")).toBe("Take 1");
    expect(exportFileName("", "")).toBe("video");
    expect(exportFileName("  ", "...")).toBe("video");
  });

  it("drops a video extension the host left on, as the export adds its own", () => {
    expect(exportFileName("holiday.MOV", "")).toBe("holiday");
    expect(exportFileName("clip.final.webm", "")).toBe("clip.final");
    expect(exportFileName("notes.txt", "")).toBe("notes.txt");
  });

  it("removes what file systems refuse, control characters and bidirectional overrides", () => {
    expect(exportFileName('a/b\\c:d*e?f"g<h>i|j', "")).toBe("a b c d e f g h i j");
    expect(exportFileName("line\none\u0000two", "")).toBe("line one two");
    // An override that would make "exe.mp4" read as "4pm.exe".
    expect(exportFileName("photo\u202egnp.exe", "")).toBe("photognp.exe");
    expect(exportFileName("..hidden..", "")).toBe("hidden");
  });

  it("keeps at most 100 characters, counting an emoji as one", () => {
    expect([...exportFileName("🎬".repeat(150), "")]).toHaveLength(100);
    expect(exportFileName("a".repeat(150), "")).toBe("a".repeat(100));
  });
});
