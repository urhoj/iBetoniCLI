import { describe, test, expect } from "vitest";
import { lineDiff } from "../src/textDiff.js";

describe("lineDiff", () => {
  test("identical input -> sameContent, empty unified, zero counts", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toEqual({
      addedLines: 0,
      removedLines: 0,
      sameContent: true,
      unified: "",
    });
  });

  test("counts added and removed lines and labels them", () => {
    const d = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(d.sameContent).toBe(false);
    expect(d.addedLines).toBe(2); // "B", "d"
    expect(d.removedLines).toBe(1); // "b"
    expect(d.unified).toContain("- b");
    expect(d.unified).toContain("+ B");
    expect(d.unified).toContain("+ d");
  });

  test("pure addition", () => {
    const d = lineDiff("a\nb", "a\nb\nc");
    expect(d).toMatchObject({ addedLines: 1, removedLines: 0, sameContent: false });
  });

  test("ignores a sole trailing newline (no spurious empty ± line)", () => {
    // "x\n" vs "x" must read as identical, not as a removed/added empty line.
    expect(lineDiff("a\nb\n", "a\nb")).toEqual({
      addedLines: 0,
      removedLines: 0,
      sameContent: true,
      unified: "",
    });
    expect(lineDiff("a\nb", "a\nb\n")).toMatchObject({ sameContent: true });
    // A real trailing-line difference (blank line in the middle) is still shown.
    const d = lineDiff("a\nb", "a\n\nb");
    expect(d.sameContent).toBe(false);
    expect(d.addedLines).toBe(1);
  });

  test("collapses long unchanged runs into a marker", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const d = lineDiff(base, `${base}\nNEW`);
    expect(d.addedLines).toBe(1);
    expect(d.unified).toContain("unchanged lines");
    expect(d.unified).toContain("+ NEW");
    // The collapsed output must be far smaller than echoing all 40 lines.
    expect(d.unified.split("\n").length).toBeLessThan(10);
  });
});
