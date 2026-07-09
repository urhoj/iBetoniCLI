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
  // Anchor on the 2-space command column (/^ {2}name\b/), NOT /^\s+name\b/.
  // Commander lists command entries at exactly a 2-space indent; a command's
  // wrapped DESCRIPTION continuation lines sit at the description column
  // (~31 spaces). The loose \s+ let a description that merely contains a word
  // like "changelog" (the `dev` blurb does) false-match when it wrapped to a
  // line start — which turned master red. Keep this anchored to the command col.
  test("standard omits ai/schema/changelog from the Commands list", () => {
    const h = rootHelp("standard");
    // The Commands: section should not list these as top-level groups.
    expect(h).not.toMatch(/^ {2}schema\b/m);
    expect(h).not.toMatch(/^ {2}changelog\b/m);
    expect(h).not.toMatch(/^ {2}ai\b/m);
    expect(h).toMatch(/^ {2}keikka\b/m); // visible domain still listed
  });
  test("developer sees dev umbrella; old hidden aliases not shown at root", () => {
    const h = rootHelp("developer");
    // dev is the new umbrella for schema/ai/changelog/feedback/perf/cache/inbox
    expect(h).toMatch(/^ {2}dev\b/m);
    // back-compat aliases are registered as Commander-hidden — absent from root help
    expect(h).not.toMatch(/^ {2}schema\b/m);
    expect(h).not.toMatch(/^ {2}ai\b/m);
    expect(h).not.toMatch(/^ {2}changelog\b/m);
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
