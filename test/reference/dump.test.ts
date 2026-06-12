import { describe, test, expect, vi } from "vitest";
import { buildReference, runReferenceDump } from "../../src/reference/dump.js";

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
    // term-contains, not exact: the entry is "tilaus / keikka"
    expect(ref.glossary.some((g) => g.term.includes("keikka"))).toBe(true);
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

  test("runReferenceDump emits single-line JSON (stdout one-line contract)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runReferenceDump("keikka");
    expect(spy.mock.calls.length).toBe(1);
    const out = spy.mock.calls[0][0] as string;
    // restore BEFORE the asserts so a failing assertion can't leak the spy
    spy.mockRestore();
    expect(out.endsWith("\n")).toBe(true);
    // exactly one line: no interior newlines (pretty-printing regression guard)
    expect(out.slice(0, -1)).not.toContain("\n");
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("ib reference dump <domain>", () => {
  test("filters commands to the domain but keeps the full primer", () => {
    const full = buildReference();
    const ref = buildReference("keikka");
    const cmds = Object.keys(ref.commands);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.every((c) => c.startsWith("ib keikka"))).toBe(true);
    expect(cmds.length).toBeLessThan(Object.keys(full.commands).length);
    // primer retained in full
    expect(ref.overview).toBe(full.overview);
    expect(ref.glossary).toEqual(full.glossary);
    expect(ref.topics).toEqual(full.topics);
    expect(ref.feedbackGuidance).toEqual(full.feedbackGuidance);
  });

  test("unknown domain throws exit-4 CliError", () => {
    try {
      buildReference("nope");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toMatchObject({ exitCode: 4 });
      expect((e as Error).message).toContain("unknown domain: nope");
    }
  });
});
