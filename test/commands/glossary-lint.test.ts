import { describe, test, expect } from "vitest";
import {
  lintEntries,
  isKnownCommandPath,
  suggestRelatedForEntry,
  isEditDistance1,
  nearDuplicateCandidates,
} from "../../src/commands/glossary/lint.js";
// Oracle for the O(len) fast path — the CLI's one Levenshtein implementation.
import { levenshtein } from "../../src/output/unknownCommand.js";
import type { CommandSpec } from "../../src/output/help.js";

// `extra` deliberately cannot reach the fields the CommandSpec union
// discriminates on (writeFlags/dryRunKind) or the required `examples` — a
// Partial<CommandSpec> spread would re-widen them back to `| undefined` and
// stop the literal satisfying either branch. Lint only reads command/
// description/flags anyway.
const spec = (
  command: string,
  extra: Partial<Omit<CommandSpec, "command" | "examples" | "writeFlags" | "dryRunKind">> = {}
): CommandSpec => ({
  command,
  description: "",
  flags: [],
  outputShape: "",
  errors: [],
  examples: [],
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
      { term: "loma", synonyms: ["lomat"], definition: "vacation", relatedCommands: [{ command: "ib bogus" }], relatedEntity: null },
      { term: "lomaa", synonyms: [], definition: "", relatedCommands: [], relatedEntity: null },
    ]);
    const issues = findings.map((f) => f.issue);
    expect(issues).toContain("dead-related");      // ib bogus
    expect(issues).toContain("empty-definition");  // lomaa
    expect(issues).toContain("near-duplicate");    // loma ~ lomaa (distance 1)
  });

  test("flags synonym-collision and no-anchor", () => {
    const findings = lintEntries([
      { term: "asiakas", synonyms: [], definition: "customer", relatedCommands: [{ command: "ib customer" }], relatedEntity: "Asiakas" },
      { term: "company", synonyms: ["asiakas"], definition: "tenant", relatedCommands: [{ command: "ib company" }], relatedEntity: "Asiakas" },
      { term: "orphan", synonyms: [], definition: "x", relatedCommands: [], relatedEntity: null },
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
      { term: "puomi", synonyms: [], definition: "boom", relatedCommands: [{ command: "ib keikka" }], relatedEntity: null },
    ];
    // Uses the real COMMAND_SPECS (default arg) — off by default, on when requested.
    expect(lintEntries(entries).some((f) => f.issue === "stale-related")).toBe(false);
    expect(lintEntries(entries, { suggestRelated: true }).some((f) => f.issue === "stale-related")).toBe(true);
  });
});

describe("nearDuplicateCandidates", () => {
  /** The pre-bucketing all-pairs scan, verbatim — the order + membership oracle. */
  const allPairs = (terms: string[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < terms.length; i++)
      for (let j = i + 1; j < terms.length; j++)
        if (isEditDistance1(terms[i], terms[j])) out.push([i, j]);
    return out;
  };
  const kept = (terms: string[]) =>
    nearDuplicateCandidates(terms).filter(([i, j]) => isEditDistance1(terms[i], terms[j]));

  test("matches the all-pairs scan exactly on a synthetic glossary", () => {
    // Mangles, duplicates, prefixes and unrelated terms mixed together.
    const terms: string[] = [];
    for (let i = 0; i < 400; i++) {
      terms.push(`termi${i}`);
      if (i % 7 === 0) terms.push(`termi${i}x`);   // insertion
      if (i % 11 === 0) terms.push(`termi${i}`);   // exact duplicate (distance 0 — no finding)
      if (i % 13 === 0) terms.push(`tarmi${i}`);   // substitution
    }
    expect(kept(terms)).toEqual(allPairs(terms));
  });

  test("matches the all-pairs scan on randomized short terms", () => {
    let seed = 424242;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const letters = "abcä";
    for (let round = 0; round < 60; round++) {
      const terms = Array.from({ length: 40 }, () =>
        Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => letters[Math.floor(rnd() * letters.length)]).join("")
      );
      expect(kept(terms), JSON.stringify(terms)).toEqual(allPairs(terms));
    }
  });

  test("handles empty and single-term inputs", () => {
    expect(nearDuplicateCandidates([])).toEqual([]);
    expect(nearDuplicateCandidates(["solo"])).toEqual([]);
    expect(kept(["", "a"])).toEqual([[0, 1]]);
  });
});

describe("isEditDistance1", () => {
  test("agrees with levenshtein === 1 across representative pairs", () => {
    const pairs: Array<[string, string]> = [
      ["puomi", "puomi"], ["puomi", "puomit"], ["puomi", "puom"], ["puomi", "suomi"],
      ["puomi", "pumi"], ["keikka", "keikat"], ["a", ""], ["", ""], ["ab", "ba"],
      ["betoni", "betonit"], ["betoni", "betoni "], ["valu", "valut"], ["valu", "velu"],
      ["abc", "abcd"], ["abc", "xabc"], ["abc", "axc"], ["abc", "cba"], ["ää", "äö"],
    ];
    for (const [a, b] of pairs) {
      expect(isEditDistance1(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        levenshtein(a, b) === 1
      );
    }
  });
});
