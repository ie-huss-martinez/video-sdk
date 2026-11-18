import { describe, expect, it } from "vitest";
import { metadataDate } from "./metadata-date.js";

describe("a metadata date", () => {
  it("is the day it names, at midnight UTC", () => {
    expect(metadataDate("2026-11-18")?.toISOString()).toBe("2026-11-18T00:00:00.000Z");
    expect(metadataDate("2024-02-29")?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(metadataDate("0050-06-01")?.getUTCFullYear()).toBe(50);
  });

  it("is none for a day that doesn't exist, rather than the day it would roll over to", () => {
    for (const text of ["2025-02-29", "2025-02-31", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      expect(metadataDate(text), text).toBeUndefined();
    }
  });

  it("is none for anything not written YYYY-MM-DD", () => {
    for (const text of ["", "18/11/2026", "2026-11-18T10:00", "2026-1-8", " 2026-11-18", "soon"]) {
      expect(metadataDate(text), text).toBeUndefined();
    }
  });
});
