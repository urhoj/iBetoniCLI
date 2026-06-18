import { describe, test, expect } from "vitest";
import { parseId, parseOptionalId } from "../src/targets.js";

/** Run fn and return the CliError exitCode it threw (or undefined if it didn't throw). */
const exitCodeOf = (fn: () => void): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
};

describe("parseId", () => {
  test("accepts a canonical positive integer (and trims surrounding space)", () => {
    expect(parseId("53", "keikkaId")).toBe(53);
    expect(parseId(" 1349 ", "asiakasId")).toBe(1349);
  });

  test("rejects every non-positive-integer form with exit 4", () => {
    for (const bad of ["abc", "", "  ", "0", "-3", "5.5", "1e3", "0x10", "12abc", "NaN"]) {
      expect(exitCodeOf(() => parseId(bad, "id"))).toBe(4);
    }
  });

  test("error names the field and echoes the offending value", () => {
    expect(() => parseId("abc", "keikkaId")).toThrow(/invalid keikkaId: "abc"/);
  });
});

describe("parseOptionalId", () => {
  test("undefined in → undefined out (the no-id-given case)", () => {
    expect(parseOptionalId(undefined, "personId")).toBeUndefined();
  });

  test("delegates to parseId for a provided value", () => {
    expect(parseOptionalId("7", "personId")).toBe(7);
    expect(exitCodeOf(() => parseOptionalId("nope", "personId"))).toBe(4);
  });
});
