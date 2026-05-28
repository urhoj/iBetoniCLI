import { describe, test, expect } from "vitest";
import { buildReference } from "../../src/reference/dump.js";

describe("ib reference dump", () => {
  test("returns a version string + non-empty commands map", () => {
    const ref = buildReference();
    expect(ref.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(ref.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(ref.commands).length).toBeGreaterThan(0);
    expect(Object.keys(ref.commands)).toContain("ib keikka list");
  });

  test("every command has flags array, outputShape, errors, examples", () => {
    const ref = buildReference();
    for (const [name, spec] of Object.entries(ref.commands)) {
      expect(Array.isArray(spec.flags), `${name} flags is array`).toBe(true);
      expect(spec.outputShape, `${name} outputShape`).toBeTruthy();
      expect(
        Array.isArray(spec.errors) && spec.errors.length > 0,
        `${name} errors non-empty`
      ).toBe(true);
      expect(
        Array.isArray(spec.examples) && spec.examples.length > 0,
        `${name} examples non-empty`
      ).toBe(true);
    }
  });
});
