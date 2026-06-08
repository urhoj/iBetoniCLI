import { describe, test, expect } from "vitest";
import { CliError } from "../../src/api/errors.js";
import { parseJsonBodyFlag } from "../../src/api/parseBody.js";

describe("parseJsonBodyFlag", () => {
  test("parses a valid JSON object", () => {
    expect(parseJsonBodyFlag('{"a":1}')).toEqual({ a: 1 });
  });

  test("throws CliError(exit 4) on malformed JSON", () => {
    try {
      parseJsonBodyFlag("{not json}");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(4);
    }
  });

  test("throws CliError(exit 4) when the body is not an object", () => {
    try {
      parseJsonBodyFlag("[1,2,3]");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(4);
    }
  });
});
