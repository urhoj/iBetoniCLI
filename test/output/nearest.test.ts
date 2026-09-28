import { describe, test, expect } from "vitest";
import { closestName, levenshtein, nearestNames, orList } from "../../src/output/nearest.js";

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

describe("nearestNames (fb#2046)", () => {
  test("offers the edit-distance winner AND the shortest name extending the typed one", () => {
    const tables = ["grid_palkit", "grid_palkkiTypes", "grid_palkkiForeignKeys", "palkkiPerson"];
    const got = nearestNames("grid_palkki", tables);
    expect(got[0]).toBe("grid_palkit");
    expect(got).toContain("grid_palkkiTypes");
  });

  test("an abbreviation of a longer name is offered even when edit distance prefers another", () => {
    const got = nearestNames("betomikOrderbookRow", ["betomikOrderbookAudit", "betomikOrderbookImportRow", "keikka"]);
    expect(got).toEqual(expect.arrayContaining(["betomikOrderbookAudit", "betomikOrderbookImportRow"]));
    expect(got).not.toContain("keikka");
  });

  test("underscores and case are ignored, so palkkiId finds grid_palkki_Id first", () => {
    expect(nearestNames("palkkiId", ["keikkaId", "grid_palkki_Id", "vehicleId"])[0]).toBe("grid_palkki_Id");
  });

  test("an exact match modulo case/underscore returns alone; nothing near returns empty", () => {
    expect(nearestNames("KEIKKA", ["keikka", "keikkaPerson"])).toEqual(["keikka"]);
    expect(nearestNames("totallyUnrelated", ["keikka"])).toEqual([]);
  });

  test("orList renders one, two and three names", () => {
    expect([orList(["a"]), orList(["a", "b"]), orList(["a", "b", "c"])]).toEqual(["a", "a or b", "a, b or c"]);
  });
});
