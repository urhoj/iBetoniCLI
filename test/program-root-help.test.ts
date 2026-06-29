import { describe, test, expect, afterEach } from "vitest";
import { buildProgram } from "../src/program.js";
import { setCallerTier } from "../src/tier.js";
import { renderDomainHelp } from "../src/reference/domain.js";

afterEach(() => setCallerTier("developer"));

function rootHelp(tier: "developer" | "standard"): string {
  setCallerTier(tier);
  return buildProgram().helpInformation();
}

describe("root --help command listing is tier-filtered", () => {
  test("standard omits ai/schema/changelog from the Commands list", () => {
    const h = rootHelp("standard");
    // The Commands: section should not list these as top-level groups.
    expect(h).not.toMatch(/^\s+schema\b/m);
    expect(h).not.toMatch(/^\s+changelog\b/m);
    expect(h).not.toMatch(/^\s+ai\b/m);
    expect(h).toMatch(/^\s+keikka\b/m); // visible domain still listed
  });
  test("developer lists schema/ai/changelog", () => {
    const h = rootHelp("developer");
    expect(h).toMatch(/^\s+schema\b/m);
    expect(h).toMatch(/^\s+ai\b/m);
    expect(h).toMatch(/^\s+changelog\b/m);
  });
});

describe("root --help GLOSSARY is a pointer, not a term dump", () => {
  test("points to ib glossary list/lookup and is only a few lines", () => {
    const primer = renderDomainHelp("developer");
    const lines = primer.split("\n");
    const gi = lines.findIndex((l) => l.startsWith("GLOSSARY"));
    const fi = lines.findIndex((l) => l.startsWith("FILING FEEDBACK"));
    expect(gi).toBeGreaterThan(-1);
    expect(fi).toBeGreaterThan(gi);
    // Header + 2 pointer lines + blank — not the ~100-line term+synonym dump.
    expect(fi - gi).toBeLessThanOrEqual(4);
    expect(primer).toContain("`ib glossary list --terms-only`");
    expect(primer).toContain("`ib glossary lookup <term>`");
  });
});
