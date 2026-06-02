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

  test("embeds a domain primer: overview + glossary", () => {
    const ref = buildReference();
    expect(typeof ref.overview).toBe("string");
    expect(ref.overview.length).toBeGreaterThan(0);
    expect(ref.overview).toMatch(/BetoniJerry/);
    expect(Array.isArray(ref.glossary)).toBe(true);
    expect(ref.glossary.length).toBeGreaterThan(0);
    for (const entry of ref.glossary) {
      expect(typeof entry.term, "glossary term").toBe("string");
      expect(entry.term.length).toBeGreaterThan(0);
      expect(typeof entry.definition, "glossary definition").toBe("string");
      expect(entry.definition.length).toBeGreaterThan(0);
    }
    expect(ref.glossary.map((g) => g.term)).toContain("keikka");
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
