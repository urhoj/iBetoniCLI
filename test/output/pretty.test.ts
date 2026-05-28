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
});
