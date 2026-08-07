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

  test("renderList does not crash on empty items with a non-zero/absent count", () => {
    // A backend page can report total-count semantics or an out-of-range cursor:
    // items:[] while count != 0. Guarding on `count===0` (the old bug) would then
    // deref items[0] and throw. Guard on the array instead.
    expect(renderList({ items: [], nextCursor: null, count: 42 })).toContain("(no results)");
    const noCount = { items: [], nextCursor: null } as unknown as Parameters<typeof renderList>[0];
    expect(renderList(noCount)).toContain("(no results)");
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
    // The blobs must DIFFER: two identical rows make every column constant, so
    // the fold below would empty the table and this would stop testing width.
    const long = "word ".repeat(80);
    const out = renderList({
      items: [
        { id: 1, blob: `alpha ${long}` },
        { id: 2, blob: `beta ${long}` },
      ],
      nextCursor: null,
      count: 2,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    const plain = stripAnsi(out);
    expect(plain).toMatch(/\bid\b/);
    // feedback #341: one line per record — the long blob is cut, not wrapped
    expect(plain.split("\n").filter((l) => l.includes("alpha")).length).toBe(1);
    expect(plain).toContain("…");
  });

  // feedback #341: --pretty on a multi-ROW list rendered one full vertical
  // key/value table PER ROW (12 feedback rows → 106 KB). The four tests below
  // pin the replacement: fold what is constant, keep one line per record, and
  // name whatever had to be dropped.
  test("renderList folds constant and all-null columns above the table", () => {
    const out = stripAnsi(
      renderList({
        items: [
          { id: 1, status: "open", note: null, kind: "bug" },
          { id: 2, status: "open", note: null, kind: "improvement" },
        ],
        nextCursor: null,
        count: 2,
      })
    );
    expect(out).toContain("all 2 rows:");
    expect(out).toContain("status=open");
    expect(out).toContain("note=—");
    // the varying columns are the only ones left in the table
    expect(out).toMatch(/│\s+id\s+│\s+kind\s+│/);
  });

  test("renderList keeps every column of a single-row list", () => {
    // Every column of a 1-row list is trivially "constant" — folding there
    // would leave an empty table.
    const out = stripAnsi(
      renderList({
        items: [{ id: 1, status: "open", note: null }],
        nextCursor: null,
        count: 1,
      })
    );
    expect(out).not.toContain("all 1 rows");
    expect(out).toContain("status");
    expect(out).toContain("note");
  });

  test("renderList honours an explicit column selection and names the rest", () => {
    const items = [
      { id: 1, kind: "bug", scope: "cli", description: "a" },
      { id: 2, kind: "improvement", scope: "app", description: "b" },
    ];
    const out = stripAnsi(
      renderList({ items, nextCursor: null, count: 2 }, ["id", "scope"])
    );
    expect(out).toMatch(/│\s+id\s+│\s+scope\s+│/);
    expect(out).toContain("2 columns hidden");
    expect(out).toContain("kind");
  });

  test("renderList ignores unknown column names and falls back to the auto fit", () => {
    const items = [
      { id: 1, kind: "bug" },
      { id: 2, kind: "improvement" },
    ];
    const out = stripAnsi(
      renderList({ items, nextCursor: null, count: 2 }, ["nope"])
    );
    expect(out).not.toContain("columns hidden");
    expect(out).toContain("kind");
  });

  test("renderList clamps a multi-row cell to its first line", () => {
    const out = stripAnsi(
      renderList({
        items: [
          { id: 1, blob: "first line\nsecond line" },
          { id: 2, blob: "other line\nsecond line" },
        ],
        nextCursor: null,
        count: 2,
      })
    );
    expect(out).toContain("first line…");
    expect(out).not.toContain("second line");
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

  test("renderList drops the columns that can't stay readable and names them", () => {
    // Distinct per row, so nothing folds and the fit itself has to do the work.
    const row = (tag: string) =>
      Object.fromEntries(
        Array.from({ length: 14 }, (_, i) => [`column${i}`, `${tag} ${i} `.repeat(8)])
      );
    const out = renderList({
      items: [row("alpha"), row("beta")],
      nextCursor: null,
      count: 2,
    });
    expect(maxLineWidth(out)).toBeLessThanOrEqual(TERM);
    const plain = stripAnsi(out);
    expect(plain).toContain("column0"); // the identity anchor is never dropped
    expect(plain).toMatch(/\d+ columns hidden/);
    expect(plain).toContain("column13"); // dropped, but named in the footer
    expect(plain).not.toContain("# 1"); // no per-record block fallback
    // still one line per record, however many columns had to go
    expect(plain.split("\n").filter((l) => l.includes("alpha")).length).toBe(1);
  });
});
