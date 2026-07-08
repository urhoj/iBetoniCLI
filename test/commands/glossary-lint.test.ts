import { describe, test, expect } from "vitest";
import { lintEntries, isKnownCommandPath, suggestRelatedForEntry } from "../../src/commands/glossary/lint.js";
import type { CommandSpec } from "../../src/output/help.js";

const spec = (command: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
  command,
  description: "",
  flags: [],
  outputShape: "",
  errors: [],
  ...extra,
});

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

describe("glossary lint --suggest-related (fb#110)", () => {
  const specs: CommandSpec[] = [
    spec("ib sijainti set-jerry", { flags: [{ name: "puomi-min", type: "number", description: "Min boom length" }] }),
    spec("ib jerry check-address", { description: "Verify a delivery address and boom (puomi) reach" }),
    spec("ib keikka", { description: "Delivery orders" }),
    spec("ib keikka list", { description: "List keikkas" }),
    spec("ib vehicle list", { description: "List vehicles" }),
  ];

  test("suggests specs mentioning the term but not yet linked", () => {
    const got = suggestRelatedForEntry(
      { term: "puomi", synonyms: [], relatedCommands: [{ command: "ib keikka" }], relatedEntity: null },
      specs
    );
    expect(got).toContain("ib sijainti set-jerry"); // flag name --puomi-min
    expect(got).toContain("ib jerry check-address"); // description mentions puomi
    expect(got).not.toContain("ib keikka");          // already linked
    expect(got).not.toContain("ib keikka list");     // covered by the linked group prefix
    expect(got).not.toContain("ib vehicle list");    // no mention of puomi
  });

  test("ranks path-match above flag-match above description-match", () => {
    const ranked = suggestRelatedForEntry(
      { term: "keikka", synonyms: [], relatedCommands: [], relatedEntity: null },
      [
        spec("ib jerry x", { description: "about keikka orders" }), // description match (1)
        spec("ib keikka list"),                                     // path match (3)
      ]
    );
    expect(ranked[0]).toBe("ib keikka list");
  });

  test("drops needles shorter than 4 chars", () => {
    expect(
      suggestRelatedForEntry({ term: "m3", synonyms: ["pvm"], relatedCommands: [], relatedEntity: null }, specs)
    ).toEqual([]);
  });

  test("stale-related only appears when suggestRelated is set", () => {
    const entries = [
      { term: "puomi", synonyms: [], definition: "boom", relatedCommands: [{ command: "ib keikka" }], relatedEntity: null } as any,
    ];
    // Uses the real COMMAND_SPECS (default arg) — off by default, on when requested.
    expect(lintEntries(entries).some((f) => f.issue === "stale-related")).toBe(false);
    expect(lintEntries(entries, { suggestRelated: true }).some((f) => f.issue === "stale-related")).toBe(true);
  });
});
