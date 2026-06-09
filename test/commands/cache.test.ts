import { describe, test, expect } from "vitest";
import { assertWritableEndpoint } from "../../src/api/endpointGuard.js";
import { CliError } from "../../src/api/errors.js";
import { CACHE_ENTITIES } from "../../src/commands/cache/entities.js";

describe("assertWritableEndpoint", () => {
  test("allows localhost without --force-prod", () => {
    expect(() => assertWritableEndpoint("http://127.0.0.1:3000", false)).not.toThrow();
    expect(() => assertWritableEndpoint("http://localhost:3000", false)).not.toThrow();
  });

  test("refuses a remote endpoint without --force-prod (exit 3)", () => {
    try {
      assertWritableEndpoint("https://api.ibetoni.fi", false);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(3);
    }
  });

  test("allows a remote endpoint when forceProd is true", () => {
    expect(() => assertWritableEndpoint("https://api.ibetoni.fi", true)).not.toThrow();
  });
});

describe("CACHE_ENTITIES vocabulary", () => {
  test("is a non-empty list of {entityType, params, example}", () => {
    expect(CACHE_ENTITIES.length).toBeGreaterThan(5);
    for (const e of CACHE_ENTITIES) {
      expect(typeof e.entityType).toBe("string");
      expect(Array.isArray(e.params)).toBe(true);
      expect(typeof e.example).toBe("string");
    }
  });

  test("includes keikka with cascade support flagged", () => {
    const keikka = CACHE_ENTITIES.find((e) => e.entityType === "keikka");
    expect(keikka).toBeDefined();
    expect(keikka!.cascade).toBe(true);
  });
});
