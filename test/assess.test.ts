import { describe, test, expect } from "vitest";
import { assertAiConfidence } from "../src/assess.js";
import { CliError, hintForError } from "../src/api/errors.js";
import { intFlag } from "../src/targets.js";
import { COMMAND_SPECS } from "../src/reference/specs.js";

describe("assertAiConfidence", () => {
  test("undefined is allowed (omitted = reset)", () => {
    expect(() => assertAiConfidence(undefined)).not.toThrow();
  });
  test("0 and 100 are allowed", () => {
    expect(() => assertAiConfidence(0)).not.toThrow();
    expect(() => assertAiConfidence(100)).not.toThrow();
  });
  test("101 throws exit-4", () => {
    try { assertAiConfidence(101); throw new Error("did not throw"); }
    catch (e) { expect((e as CliError).exitCode).toBe(4); }
  });
  test("non-integer throws exit-4", () => {
    try { assertAiConfidence(50.5); throw new Error("did not throw"); }
    catch (e) { expect((e as CliError).exitCode).toBe(4); }
  });
});

// fb#975: --max-confidence's min is deliberately 0, not 1 (a threshold of 0 is
// meaningful — see the JSDoc on addNeedsReviewFlags in src/assess.ts). Only the
// reject path was covered elsewhere; nothing asserted the boundary is ACCEPTED,
// so a future refactor could silently reintroduce min=1 with no red test.
describe("--max-confidence accepts its 0 boundary (fb#975)", () => {
  test("0 parses to the number 0, not a rejection", () => {
    expect(intFlag("--max-confidence", 0)("0")).toBe(0);
  });
});

// fb#974: before this fix, none of the three assertAiConfidence consumers
// carried an ERRORS row naming the guard, so a caller hitting it got the raw
// message with no remedy attached — verified here by resolving the SAME
// error the guard actually throws through the SAME hint pipeline the CLI uses.
describe("--ai-confidence guard is documented on every consumer (fb#974)", () => {
  const guardError = (): CliError => {
    try {
      assertAiConfidence(101);
      throw new Error("did not throw");
    } catch (e) {
      return e as CliError;
    }
  };

  test.each([
    "ib glossary set",
    "ib ohje update",
    "ib reference detail set",
  ])("%s carries a hint for the --ai-confidence range guard", (command) => {
    const spec = COMMAND_SPECS.find((s) => s.command === command);
    expect(spec).toBeDefined();
    const hint = hintForError(guardError(), spec?.errors ?? null);
    expect(hint).toContain("integer 0-100");
  });
});
