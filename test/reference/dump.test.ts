import { describe, test, expect, vi } from "vitest";
import { buildReference, runReferenceDump, projectGlossaryForPrimer } from "../../src/reference/dump.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

describe("ib reference dump", () => {
  test("returns a version string + non-empty commands map", () => {
    const ref = buildReference();
    expect(ref.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(ref.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(ref.commands).length).toBeGreaterThan(0);
    expect(Object.keys(ref.commands)).toContain("ib keikka list");
  });

  test("embeds a domain primer: overview + glossary defaults to []", () => {
    const ref = buildReference();
    expect(typeof ref.overview).toBe("string");
    expect(ref.overview.length).toBeGreaterThan(0);
    expect(ref.overview).toMatch(/BetoniJerry/);
    // No injected glossary → empty array (DB-backed; no offline bundled copy)
    expect(Array.isArray(ref.glossary)).toBe(true);
    expect(ref.glossary).toEqual([]);
  });

  test("injected glossary appears under the glossary key", () => {
    const injected = [
      { term: "keikka", synonyms: ["tilaus"] },
      { term: "asiakas", synonyms: [] },
    ];
    const ref = buildReference(undefined, "developer", injected);
    expect(ref.glossary).toEqual(injected);
    expect(ref.glossary.length).toBe(2);
    expect(ref.glossary[0].term).toBe("keikka");
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

describe("ib reference dump <domain...> (multiple domains)", () => {
  test("an array of domains keeps every listed group's commands under one primer", () => {
    const ref = buildReference(["keikka", "vehicle"]);
    const cmds = Object.keys(ref.commands);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds.some((c) => c.startsWith("ib keikka"))).toBe(true);
    expect(cmds.some((c) => c.startsWith("ib vehicle"))).toBe(true);
    // nothing outside the two requested domains
    expect(cmds.every((c) => /^ib (keikka|vehicle)\b/.test(c))).toBe(true);
    // single primer retained
    expect(ref.overview).toMatch(/BetoniJerry/);
  });

  test("an empty array behaves like no domain (full surface)", () => {
    expect(Object.keys(buildReference([]).commands)).toEqual(
      Object.keys(buildReference().commands)
    );
  });

  test("a single bad domain among good ones still exit-4s", () => {
    expect(() => buildReference(["keikka", "nope"])).toThrowError(/unknown domain: nope/);
  });
});

describe("ib reference dump --commands-only", () => {
  test("emits only { version, generatedAt, commands } — no primer", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runReferenceDump("keikka", "developer", [], true);
    const out = spy.mock.calls[0][0] as string;
    spy.mockRestore();
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["commands", "generatedAt", "version"]);
    expect(parsed.overview).toBeUndefined();
    expect(parsed.glossary).toBeUndefined();
    expect(parsed.topics).toBeUndefined();
    expect(parsed.feedbackGuidance).toBeUndefined();
    expect(Object.keys(parsed.commands).every((c) => c.startsWith("ib keikka"))).toBe(true);
  });

  test("without --commands-only the primer is present (regression guard)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runReferenceDump("keikka", "developer", []);
    const out = spy.mock.calls[0][0] as string;
    spy.mockRestore();
    const parsed = JSON.parse(out);
    expect(parsed.overview).toBeTruthy();
    expect("feedbackGuidance" in parsed).toBe(true);
  });
});

describe("reference dump tier filtering", () => {
  test("standard omits developer commands", () => {
    const std = buildReference(undefined, "standard");
    expect(Object.keys(std.commands)).not.toContain("ib ai conversation");
    expect(Object.keys(std.commands)).toContain("ib feedback create");
    // glossary is injected (not bundled) — always [] when nothing passed
    expect(std.glossary).toEqual([]);
  });
  test("developer dump retains developer commands", () => {
    const dev = buildReference(undefined, "developer");
    expect(Object.keys(dev.commands)).toContain("ib ai conversation");
    // glossary defaults to [] without injection
    expect(dev.glossary).toEqual([]);
  });
  test("default tier is developer (back-compat)", () => {
    expect(Object.keys(buildReference().commands)).toContain("ib ai conversation");
  });
  test("domain-filtered dump carries the injected glossary unchanged", () => {
    const injected = [{ term: "keikka", synonyms: [] }];
    const full = buildReference(undefined, "standard", injected);
    const narrowed = buildReference("keikka", "standard", injected);
    expect(narrowed.glossary).toEqual(full.glossary);
    expect(narrowed.glossary).toEqual(injected);
  });
});

describe("reference dump leaks no hidden command path (notes/seeAlso/examples)", () => {
  test("standard dump JSON contains NO hidden command path anywhere", () => {
    // inject a glossary that mentions no hidden commands (simulates DB fetch)
    const std = JSON.stringify(buildReference(undefined, "standard", []));
    const hidden = COMMAND_SPECS.filter((s) => s.tier === "developer").map((s) => s.command);
    for (const h of hidden) expect(std).not.toContain(h);
  });
  test("developer dump still contains the cross-references (parity, not over-scrubbed)", () => {
    const dev = JSON.stringify(buildReference(undefined, "developer"));
    expect(dev).toContain("ib ai conversation"); // present for developers
  });
});

describe("projectGlossaryForPrimer — glossary projection security", () => {
  test("strips relatedCommands and other extra DB fields from glossary items", () => {
    // Simulate a DB row that includes relatedCommands referencing a developer-tier command.
    const rawItems = [
      {
        term: "ai",
        synonyms: [],
        definition: "AI assistant interface",
        relatedCommands: ["ib ai conversation"],
        relatedEntity: "ai",
        runs: 42,
        lastReviewed: "2026-06-01T00:00:00.000Z",
      },
      {
        term: "keikka",
        synonyms: ["tilaus"],
        definition: "A concrete delivery order",
        relatedCommands: [],
        relatedEntity: "keikka",
        runs: 0,
        lastReviewed: null,
      },
    ];
    const projected = projectGlossaryForPrimer(rawItems);
    // Must contain ONLY term, synonyms — definition is dropped (kept out of the
    // primer to bound dump size), as are all other DB fields.
    for (const item of projected) {
      expect(Object.keys(item)).toEqual(["term", "synonyms"]);
      expect("definition" in item).toBe(false);
      expect("relatedCommands" in item).toBe(false);
      expect("relatedEntity" in item).toBe(false);
      expect("runs" in item).toBe(false);
      expect("lastReviewed" in item).toBe(false);
    }
    // Values are preserved correctly.
    expect(projected[0]).toEqual({ term: "ai", synonyms: [] });
    expect(projected[1]).toEqual({ term: "keikka", synonyms: ["tilaus"] });
  });

  test("projected glossary injected into standard dump does not leak hidden command paths", () => {
    const rawItems = [
      {
        term: "ai",
        synonyms: [],
        definition: "AI assistant interface",
        relatedCommands: ["ib ai conversation"],
      },
    ];
    const projected = projectGlossaryForPrimer(rawItems);
    const std = JSON.stringify(buildReference(undefined, "standard", projected));
    // The hidden command path must NOT appear anywhere in the dump output.
    expect(std).not.toContain("ib ai conversation");
    // The term should be present; the definition is intentionally dropped.
    expect(std).toContain('"term":"ai"');
    expect(std).not.toContain("AI assistant interface");
  });
});
