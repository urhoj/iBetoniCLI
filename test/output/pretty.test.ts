import { describe, test, expect } from "vitest";
import { createRequire } from "node:module";
import { renderList, renderRecord, visibleWidth } from "../../src/output/pretty";

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

  test("renderList surfaces extra scalar envelope keys as a context line", () => {
    // `schema indexes` carries statsSince, `perf slow` totalCount/environment —
    // context that changes how the table is read must not be JSON-only.
    const env = {
      statsSince: "2026-08-09T04:39:19.553Z",
      items: [{ id: 1 }, { id: 2 }],
      nextCursor: null,
      count: 2,
    } as unknown as Parameters<typeof renderList>[0];
    const out = renderList(env);
    expect(out).toContain("statsSince: 2026-08-09T04:39:19.553Z");
  });

  test("renderList context line survives an empty page; envelope-own and object keys stay out", () => {
    // The empty page is where the context matters most: `--unused` finding
    // nothing is only an answer relative to statsSince.
    const empty = {
      statsSince: "2026-08-09T04:39:19.553Z",
      hint: "should not render",
      items: [],
      nextCursor: null,
      count: 0,
    } as unknown as Parameters<typeof renderList>[0];
    const out = renderList(empty);
    expect(out).toContain("statsSince:");
    expect(out).toContain("(no results)");
    expect(out).not.toContain("hint");
    expect(out).not.toContain("count:");
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

  // fb#604: a cell containing NEWLINES hit a cli-table3 0.6.5 path that is
  // O(lines × chars²) — `ib dev feedback get 528 --pretty` (a 5134-char,
  // ~50-line description) took 18.6 s and read as a hang. See the
  // `patchTableTruncate` comment in src/output/pretty.ts.
  //
  // Measured on THIS fixture (not fb#528's, which is the bigger 17 s one):
  // 8-11 s unpatched depending on machine load, ~4 ms patched. So the 2 s
  // budget sits >=4x under broken and ~500x over healthy — loud on a
  // regression, not timing-flaky. Do NOT raise it above ~4 s: a runner that
  // hands the worker a wide TTY stops the table wrapping, and that is the
  // cheapest the BROKEN path ever gets (~4.4 s). Shrinking the fixture has the
  // same effect — halve the lines and broken lands near the budget — so leave
  // the 50 x ~89 chars alone.
  test("renderRecord stays fast on a long multi-line field", () => {
    const description = Array.from(
      { length: 50 },
      (_, i) => `Line ${i}: ${"lorem ipsum dolor sit amet ".repeat(3)}`
    ).join("\n");
    const started = Date.now();
    const out = stripAnsi(renderRecord({ feedbackId: 528, description }));
    expect(Date.now() - started).toBeLessThan(2000);
    // and nothing was dropped on the way — the LAST line survives
    expect(out).toContain("Line 49:");
  });

  // fb#627: `visibleWidth` measured cells in UTF-16 CODE UNITS while cli-table3
  // measures in DISPLAY COLUMNS, so the two disagreed and `fitColumns` applied
  // the wrong constraint — or none at all. These assert in DISPLAY columns,
  // using the same measure the renderer does; `maxLineWidth` above counts code
  // units and would pass on exactly the broken case.
  const strlen = (createRequire(import.meta.url)("cli-table3/src/utils.js") as {
    strlen: (s: string) => number;
  }).strlen;
  const maxDisplayWidth = (s: string) => strlen(stripAnsi(s));

  // The measure itself, asserted directly. This is the discriminating test:
  // `line.length` (the old implementation) returns 1 for a wide char and 2 for
  // a decomposed "ä", so each case below pins one direction of the skew.
  test("visibleWidth measures DISPLAY columns, not code units (fb#627)", () => {
    // Wide: 1 UTF-16 code unit, 2 display columns.
    expect("混".length).toBe(1);
    expect(visibleWidth("混")).toBe(2);

    // Combining mark: 2 code units, 1 display column. Finnish ä/ö arrive this
    // way (NFD) from some sources, so this direction is not hypothetical here.
    const decomposedA = "a\u0308";
    expect(decomposedA.length).toBe(2);
    expect(visibleWidth(decomposedA)).toBe(1);
    expect(visibleWidth("Hämeenlinna".normalize("NFD"))).toBe(
      visibleWidth("Hämeenlinna".normalize("NFC"))
    );

    // Unchanged contracts: colour escapes are not width, and a multi-line cell
    // measures as its LONGEST line.
    expect(visibleWidth("\u001b[31mred\u001b[39m")).toBe(3);
    expect(visibleWidth("ab\nabcd\na")).toBe(4);
  });

  // The OTHER half of fb#627, and the one the measure fix did NOT close: with
  // `visibleWidth` corrected, `clampCell` still SLICED by code units, so
  // decomposed text lost one character of content per combining mark — the same
  // Finnish rendered 26 visible columns in NFD against 29 in NFC. The unit test
  // above passes either way, which is exactly why this one has to exist.
  test("NFD and NFC render identical content in a CLAMPED cell (fb#627)", () => {
    const long = "Hämeenlinnan työmaa Hämeenlinnan työmaa Hämeenlinnan työmaa";
    // Wide enough that fitColumns MUST cap this column, so clampCell runs at all.
    const rows = (t: string) => ({
      items: [
        { id: 1, paikka: `${t} yksi`, muu: "a".repeat(24), m3: 12 },
        { id: 2, paikka: `${t} kaksi`, muu: "b".repeat(24), m3: 34 },
        { id: 3, paikka: `${t} kolme`, muu: "c".repeat(24), m3: 56 },
      ],
      nextCursor: null,
      count: 3,
    });
    const bodyOf = (s: string) =>
      stripAnsi(renderList(rows(s)))
        .split("\n")
        .filter((l) => l.includes("meenlinnan"));

    const nfc = bodyOf(long.normalize("NFC"));
    const nfd = bodyOf(long.normalize("NFD"));

    expect(nfd.length).toBeGreaterThan(0);
    expect(nfd).toEqual(nfc);
    expect(maxDisplayWidth(nfd.join("\n"))).toBeLessThanOrEqual(TERM);
  });

  test("a WIDE-character table still fits the terminal (fb#627)", () => {
    // Sized so the two measures DISAGREE about fitting: 54 CJK chars is 54 code
    // units (old measure: "fits, no constraint needed") but 108 display columns
    // — wider than the whole 100-column budget on its own. That gap is what let
    // a table render 139 columns wide. A smaller fixture passes either way and
    // tests nothing.
    //
    // The note must also DIFFER per row: a value identical in every row is
    // folded out as a constant column above the table, which would quietly
    // remove the very cell under test (this fixture's first draft did exactly
    // that and passed against the broken code).
    const items = Array.from({ length: 3 }, (_, i) => ({
      id: i,
      note: `${"混凝土泵送作业记録".repeat(6)}${i}`,
      site: `工地${i}`,
    }));
    expect(items[0].note.length).toBeLessThan(TERM);

    const out = renderList({ items, nextCursor: null, count: items.length });

    expect(maxDisplayWidth(out)).toBeLessThanOrEqual(TERM);
    // Width alone would also pass against an implementation that grossly
    // OVER-measures (table merely too narrow). Pin the fb#341 invariant too:
    // one line per record, not re-wrapped.
    expect(stripAnsi(out).split("\n").filter((l) => l.includes("混凝土")).length).toBe(3);
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
