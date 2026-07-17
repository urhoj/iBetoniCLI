import { describe, test, expect } from "vitest";
import { parseId, parseOptionalId, parseRefId } from "../src/targets.js";

/** Run fn and return the CliError exitCode it threw (or undefined if it didn't throw). */
const exitCodeOf = (fn: () => void): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { exitCode?: number }).exitCode;
  }
};

/** Run fn and return the CliError it threw (or undefined if it didn't throw). */
const errorOf = (
  fn: () => void
): { exitCode?: number; message?: string; hint?: string; body?: unknown } | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { exitCode?: number; message?: string; hint?: string; body?: unknown };
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

describe("parseRefId (feedback #230 fb#/cl# anchor)", () => {
  test("a bare number passes through unchanged (both types)", () => {
    expect(parseRefId("230", "feedback", "get")).toBe(230);
    expect(parseRefId(" 858 ", "changelog", "get")).toBe(858);
  });

  test("a MATCHING prefix is stripped — every accepted spelling/separator/case", () => {
    for (const s of ["fb#230", "fb230", "fb-230", "fb:230", "fb_230", "FB#230", "f#230", "f230"]) {
      expect(parseRefId(s, "feedback", "get")).toBe(230);
    }
    for (const s of ["cl#858", "cl858", "CL-858", "c:858", "c858"]) {
      expect(parseRefId(s, "changelog", "get")).toBe(858);
    }
  });

  test("a WRONG-type prefix → exit 4, code WRONG_REF_TYPE, corrective command in the hint", () => {
    const e = errorOf(() => parseRefId("cl#858", "feedback", "get"));
    expect(e?.exitCode).toBe(4);
    expect((e?.body as { code?: string })?.code).toBe("WRONG_REF_TYPE");
    expect(e?.message).toMatch(/cl#858 is a changelog id, not a feedback id/);
    expect(e?.hint).toBe("run: ib dev changelog get 858");

    const e2 = errorOf(() => parseRefId("fb#230", "changelog", "get"));
    expect(e2?.exitCode).toBe(4);
    expect(e2?.hint).toBe("run: ib dev feedback get 230");
  });

  test("the corrective hint mirrors the verb when the other tree has it, else falls back to get", () => {
    // changelog HAS update → mirror it
    expect(errorOf(() => parseRefId("cl#858", "feedback", "update"))?.hint).toBe(
      "run: ib dev changelog update 858"
    );
    // changelog has NO resolve → fall back to get
    expect(errorOf(() => parseRefId("cl#858", "feedback", "resolve"))?.hint).toBe(
      "run: ib dev changelog get 858"
    );
    // feedback has NO delete → fall back to get
    expect(errorOf(() => parseRefId("fb#230", "changelog", "delete"))?.hint).toBe(
      "run: ib dev feedback get 230"
    );
    // feedback HAS update → mirror it
    expect(errorOf(() => parseRefId("fb#230", "changelog", "update"))?.hint).toBe(
      "run: ib dev feedback update 230"
    );
  });

  test("a matching prefix on a non-positive id is still rejected by parseId (exit 4, not WRONG_REF_TYPE)", () => {
    const e = errorOf(() => parseRefId("fb#0", "feedback", "get"));
    expect(e?.exitCode).toBe(4);
    expect((e?.body as { code?: string })?.code).toBeUndefined();
  });

  test("an unknown letter prefix or garbage falls to parseId's canonical-integer guard (exit 4)", () => {
    for (const bad of ["x230", "abc", "5.5", "230abc", "0x10"]) {
      expect(exitCodeOf(() => parseRefId(bad, "feedback", "get"))).toBe(4);
    }
  });
});
