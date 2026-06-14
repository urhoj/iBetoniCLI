import { describe, test, expect } from "vitest";
import { renderList, renderRecord } from "../../src/output/pretty";

describe("pretty output", () => {
  test("renderList formats an envelope into a table string", () => {
    const out = renderList({
      items: [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ],
      nextCursor: null,
      count: 2,
    });
    expect(out).toContain("id");
    expect(out).toContain("name");
    expect(out).toContain("A");
    expect(out).toContain("B");
  });

  test("renderList handles empty items", () => {
    const out = renderList({ items: [], nextCursor: null, count: 0 });
    expect(out).toContain("(no results)");
  });

  test("renderRecord formats a single record", () => {
    const out = renderRecord({ keikkaId: 9001, pvm: "2026-06-01" });
    expect(out).toMatch(/keikkaId.*9001/);
    expect(out).toMatch(/pvm.*2026-06-01/);
  });

  // feedback #34: --pretty exploded nested payloads (ib company validate jerry: 1.5KB
  // JSON → ~30KB table with 1200-char lines). Tables must never exceed the
  // terminal width, and arrays of objects render as per-row key:value lines.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replace(/\u001b\[\d+(?:;\d+)*m/g, "");
  const maxLineWidth = (s: string) =>
    Math.max(...stripAnsi(s).split("\n").map((l) => l.length));
  // process.stdout.columns is undefined under vitest → DEFAULT_TERM_WIDTH 100
  const TERM = 100;

  test("renderRecord caps table width at the terminal for nested arrays", () => {
    const checks = Array.from({ length: 10 }, (_, i) => ({
      id: `check.${i}`,
      severity: "required",
      titleFi: "Pitkähkö suomenkielinen tarkistuksen otsikko joka vie tilaa",
      status: "fail",
      detail: "Selitys siitä mikä puuttuu ja mistä asetuksesta sen voi korjata",
    }));
    const out = renderRecord({
      profile: "jerry",
      asiakasId: 27,
      ok: false,
      summary: { required: "3/7", recommended: "3/3" },
      checks,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    // array of objects renders as key:value lines, not a JSON blob
    expect(out).not.toContain('[{"id"');
    expect(stripAnsi(out)).toContain("id: check.0");
  });

  test("renderRecord renders empty array and plain object cells as JSON", () => {
    const out = stripAnsi(renderRecord({ a: [], b: { x: 1 } }));
    expect(out).toContain("[]");
    expect(out).toContain('{"x":1}');
  });

  test("renderList caps table width and keeps narrow columns intact", () => {
    const long = "word ".repeat(80);
    const out = renderList({
      items: [
        { id: 1, blob: long },
        { id: 2, blob: long },
      ],
      nextCursor: null,
      count: 2,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    expect(stripAnsi(out)).toMatch(/\bid\b/);
  });

  test("renderList splits evenly when every column is oversized", () => {
    const out = renderList({
      items: [{ a: "x".repeat(300), b: "y".repeat(300) }],
      nextCursor: null,
      count: 1,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    // hard wrap preserves all content (no “…” truncation)
    expect(stripAnsi(out).match(/x/g)?.length).toBe(300);
  });

  test("renderList falls back to key:value blocks when columns can't stay readable", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`column${i}`, `value ${i} `.repeat(8)])
    );
    const out = renderList({
      items: [wide, wide],
      nextCursor: null,
      count: 2,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    const plain = stripAnsi(out);
    expect(plain).toContain("# 1");
    expect(plain).toContain("# 2");
    expect(plain).toContain("column13"); // keys stay whole, not squeezed to 6 chars
  });
});
