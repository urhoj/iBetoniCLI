import { describe, test, expect } from "vitest";
import { closestName, levenshtein } from "../../src/output/nearest.js";

describe("closestName", () => {
  test("a prefix shared by two names picks the shorter/closer one (fb#1826)", () => {
    expect(closestName("dailyMessageBox", ["dailyMessageBoxAsiakas", "dailyMessageBoxes"])).toBe(
      "dailyMessageBoxes"
    );
  });

  test("an exact-length prefix tie breaks alphabetically, not by array order (fb#1837)", () => {
    expect(closestName("palk", ["palkkiZ", "palkkiA"])).toBe("palkkiA");
    // Order in the input array must not matter.
    expect(closestName("palk", ["palkkiA", "palkkiZ"])).toBe("palkkiA");
  });

  test("ends-with beats a longer unrelated substring match", () => {
    expect(closestName("id", ["kind", "feedbackId"])).toBe("feedbackId");
  });

  test("falls through to edit distance when nothing prefixes/contains the target", () => {
    expect(closestName("keika", ["keikka", "asiakas"])).toBe("keikka");
  });

  test("falls through to a synonym when edit distance misses", () => {
    expect(closestName("show", ["get", "list"])).toBe("get");
  });

  test("returns null for an empty target or empty candidate list", () => {
    expect(closestName("", ["keikka"])).toBeNull();
    expect(closestName("keikka", [])).toBeNull();
  });
});

describe("levenshtein", () => {
  test("classic edit-distance cases", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});
