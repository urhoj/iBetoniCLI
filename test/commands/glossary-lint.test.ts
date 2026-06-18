import { describe, test, expect } from "vitest";
import { lintEntries, isKnownCommandPath } from "../../src/commands/glossary/lint.js";

describe("glossary lint", () => {
  test("isKnownCommandPath matches a leaf or a group prefix", () => {
    expect(isKnownCommandPath("ib person day")).toBe(true);   // group prefix
    expect(isKnownCommandPath("ib keikka list")).toBe(true);  // leaf
    expect(isKnownCommandPath("ib bogus thing")).toBe(false);
  });

  test("flags dead-related, empty-definition, near-duplicate", () => {
    const findings = lintEntries([
      { term: "loma", synonyms: ["lomat"], definition: "vacation", relatedCommands: [{ command: "ib bogus", summary: null }], relatedEntity: null } as any,
      { term: "lomaa", synonyms: [], definition: "", relatedCommands: [], relatedEntity: null } as any,
    ]);
    const issues = findings.map((f) => f.issue);
    expect(issues).toContain("dead-related");      // ib bogus
    expect(issues).toContain("empty-definition");  // lomaa
    expect(issues).toContain("near-duplicate");    // loma ~ lomaa (distance 1)
  });

  test("flags synonym-collision and no-anchor", () => {
    const findings = lintEntries([
      { term: "asiakas", synonyms: [], definition: "customer", relatedCommands: [{ command: "ib customer", summary: null }], relatedEntity: "Asiakas" } as any,
      { term: "company", synonyms: ["asiakas"], definition: "tenant", relatedCommands: [{ command: "ib company", summary: null }], relatedEntity: "Asiakas" } as any,
      { term: "orphan", synonyms: [], definition: "x", relatedCommands: [], relatedEntity: null } as any,
    ]);
    const issues = findings.map((f) => f.issue);
    expect(issues).toContain("synonym-collision"); // company's synonym 'asiakas' == another term
    expect(issues).toContain("no-anchor");          // orphan: no relatedCommands, no relatedEntity
  });
});
