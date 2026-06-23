import { describe, test, expect } from "vitest";
import { assertAiConfidence } from "../src/assess.js";
import { CliError } from "../src/api/errors.js";

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
