import { describe, test, expect, vi } from "vitest";
import { buildReference, runReferenceDump, projectGlossaryForPrimer } from "../../src/reference/dump.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { isHiddenAtTier, scrubSpecForTier } from "../../src/tier.js";
import type { CommandSpec } from "../../src/output/help.js";

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

  test("every command has flags array, outputShape, errors array, examples", () => {
    const ref = buildReference();
    for (const [name, spec] of Object.entries(ref.commands)) {
      expect(Array.isArray(spec.flags), `${name} flags is array`).toBe(true);
      expect(spec.outputShape, `${name} outputShape`).toBeTruthy();
      // errors is always an array but MAY be empty now: the universal 401/500
      // are hoisted to the top-level `commonErrors`, so a spec whose only
      // errors were those globals legitimately ends up with [].
      expect(Array.isArray(spec.errors), `${name} errors is array`).toBe(true);
      expect(
        Array.isArray(spec.examples) && spec.examples.length > 0,
        `${name} examples non-empty`
      ).toBe(true);
    }
  });

  test("hoists the universal 401/500 contract into top-level commonErrors and strips it from specs", () => {
    const ref = buildReference();
    // commonErrors carries exactly the 401 + 500 rows.
    expect(ref.commonErrors.map((e) => e.http).sort()).toEqual([401, 500]);
    // No surviving spec repeats a hoisted global row VERBATIM. (A command may
    // still declare its OWN 401/500 with a different meaning/remedy — e.g.
    // `auth login`'s 500 "retry later" — and those legitimately stay inline.)
    const isHoisted = (e: { http?: number; exit: number; meaning: string; remedy: string }) =>
      ref.commonErrors.some(
        (c) =>
          c.http === e.http &&
          c.exit === e.exit &&
          c.meaning === e.meaning &&
          c.remedy === e.remedy
      );
    for (const [name, spec] of Object.entries(ref.commands)) {
      expect(spec.errors.some(isHoisted), `${name} must not repeat a hoisted row`).toBe(false);
    }
    // A spec that keeps command-specific errors still has them (e.g. keikka list's 403).
    expect(ref.commands["ib keikka list"].errors.length).toBeGreaterThan(0);
  });

  test("full (no-domain) dump carries a notice steering to per-domain; filtered dump does not", () => {
    expect(typeof buildReference().notice).toBe("string");
    expect(buildReference().notice).toMatch(/reference dump <domain>/);
    expect(buildReference("keikka").notice).toBeUndefined();
  });

  test("--lean drops notes + seeAlso from every spec but KEEPS examples", () => {
    const full = buildReference();
    const lean = buildReference(undefined, "developer", [], true);
    // Sanity: the default dump has specs that carry notes / seeAlso.
    const hadNotes = Object.values(full.commands).some((s) => s.notes?.length);
    const hadSeeAlso = Object.values(full.commands).some((s) => s.seeAlso?.length);
    expect(hadNotes && hadSeeAlso).toBe(true);
    // Lean: no spec retains notes or seeAlso; every spec still has examples.
    for (const [name, spec] of Object.entries(lean.commands)) {
      expect(spec.notes, `${name} notes dropped`).toBeUndefined();
      expect(spec.seeAlso, `${name} seeAlso dropped`).toBeUndefined();
      expect(spec.examples.length, `${name} examples kept`).toBeGreaterThan(0);
    }
    // Lean is strictly smaller than the default.
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length);
    // The notice advertises the lean mode it is in.
    expect(lean.notice).toMatch(/LEAN/);
    expect(full.notice).toMatch(/--lean/);
  });

  test("--lean composes with --commands-only (specs still stripped of prose)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runReferenceDump("keikka", "developer", [], true, true); // commandsOnly + lean
    const out = spy.mock.calls[0][0] as string;
    spy.mockRestore();
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual([
      "commands",
      "commonErrors",
      "generatedAt",
      "version",
    ]);
    for (const spec of Object.values(parsed.commands) as Array<Record<string, unknown>>) {
      expect(spec.notes).toBeUndefined();
      expect(spec.seeAlso).toBeUndefined();
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
  test("emits only { version, generatedAt, commonErrors, commands } — no primer", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    runReferenceDump("keikka", "developer", [], true);
    const out = spy.mock.calls[0][0] as string;
    spy.mockRestore();
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual([
      "commands",
      "commonErrors",
      "generatedAt",
      "version",
    ]);
    // commonErrors must survive --commands-only: specs no longer carry the
    // 401/500 inline, so the contract has to travel with the commands map.
    expect(parsed.commonErrors.map((e: { http: number }) => e.http).sort()).toEqual([401, 500]);
    expect(parsed.overview).toBeUndefined();
    expect(parsed.glossary).toBeUndefined();
    expect(parsed.topics).toBeUndefined();
    expect(parsed.feedbackGuidance).toBeUndefined();
    expect(parsed.notice).toBeUndefined();
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
    expect(Object.keys(std.commands)).not.toContain("ib dev ai conversation");
    expect(Object.keys(std.commands)).toContain("ib dev feedback create");
    // glossary is injected (not bundled) — always [] when nothing passed
    expect(std.glossary).toEqual([]);
  });
  test("developer dump retains developer commands", () => {
    const dev = buildReference(undefined, "developer");
    expect(Object.keys(dev.commands)).toContain("ib dev ai conversation");
    // glossary defaults to [] without injection
    expect(dev.glossary).toEqual([]);
  });
  test("default tier is developer (back-compat)", () => {
    expect(Object.keys(buildReference().commands)).toContain("ib dev ai conversation");
  });
  test("domain-filtered dump carries the injected glossary unchanged", () => {
    const injected = [{ term: "keikka", synonyms: [] }];
    const full = buildReference(undefined, "standard", injected);
    const narrowed = buildReference("keikka", "standard", injected);
    expect(narrowed.glossary).toEqual(full.glossary);
    expect(narrowed.glossary).toEqual(injected);
  });
});

describe("reference dump leaks no hidden command path (prose + error remedies)", () => {
  // Enumerate hidden paths with isHiddenAtTier, NOT `tier === "developer"`: at
  // standard, `tier: "admin"` commands are hidden too, and the narrower check let
  // `ib auth impersonate` (named in `auth whoami` / `auth refresh` remedies) leak
  // into the standard dump for real (feedback #288).
  for (const tier of ["standard", "admin"] as const) {
    test(`${tier} dump JSON contains NO hidden command path anywhere`, () => {
      // inject a glossary that mentions no hidden commands (simulates DB fetch)
      const json = JSON.stringify(buildReference(undefined, tier, []));
      const hidden = COMMAND_SPECS.filter((s) => isHiddenAtTier(s, tier)).map(
        (s) => s.command
      );
      expect(hidden.length, `${tier} must hide something`).toBeGreaterThan(0);
      for (const h of hidden) expect(json, `${tier} dump names ${h}`).not.toContain(h);
    });
  }
  test("developer dump still contains the cross-references (parity, not over-scrubbed)", () => {
    const dev = JSON.stringify(buildReference(undefined, "developer"));
    expect(dev).toContain("ib dev ai conversation"); // present for developers
  });

  test("an error row whose REMEDY names a hidden command keeps its contract, loses the prose", () => {
    // `ib auth whoami` is auth:"any" (visible everywhere); its impersonation-expired
    // remedy names `ib auth impersonate` (tier:"admin").
    const std = buildReference("auth", "standard", []).commands["ib auth whoami"];
    const row = std.errors.find((e) => /Impersonation session expired/.test(e.meaning));
    expect(row, "the row must SURVIVE — exit 2 is still the contract").toBeTruthy();
    expect(row?.exit).toBe(2);
    expect(row?.remedy).toBe(
      "not available at your access level — run `ib commands` to see what you can run"
    );
    // Developer tier keeps the real remedy (parity).
    const dev = buildReference("auth", "developer", []).commands["ib auth whoami"];
    expect(
      dev.errors.find((e) => /Impersonation session expired/.test(e.meaning))?.remedy
    ).toContain("ib auth impersonate");
  });

  test("an error row whose MEANING names a hidden command is dropped entirely", () => {
    const spec: CommandSpec = {
      command: "ib keikka list",
      description: "d",
      flags: [],
      outputShape: "o",
      errors: [
        {
          origin: "client",
          exit: 4,
          meaning: "Conflicts with `ib dev ai conversation`",
          remedy: "drop it",
        },
        { http: 404, exit: 5, meaning: "Not found", remedy: "see `ib dev ai conversation`" },
        {
          http: 403,
          exit: 3,
          meaning: "Permission denied",
          remedy: "check auth.page.grid.tilaus.read",
        },
      ],
      examples: ["ib keikka list"],
    };
    const out = scrubSpecForTier(spec, "standard", ["ib dev ai conversation"]);
    expect(out.errors.map((e) => e.exit)).toEqual([5, 3]); // exit-4 row dropped
    expect(out.errors[0].remedy).toMatch(/^not available at your access level/);
    // The rewrite must preserve the row's origin tag (fb#289): `http` still 404,
    // or hintForError could never match the row again.
    expect(out.errors[0].http).toBe(404);
    expect(out.errors[1]).toEqual(spec.errors[2]); // clean row untouched
    // Developer tier: byte-for-byte parity (same object identity).
    expect(scrubSpecForTier(spec, "developer", ["ib dev ai conversation"])).toBe(spec);
  });

  test("the hoisted 401/500 rows are still stripped after the scrub reorder", () => {
    // stripCommonErrors matches by remedy equality, so it must run BEFORE the
    // scrub can rewrite a remedy — otherwise the globals reappear per spec.
    const std = buildReference(undefined, "standard", []);
    const hoisted = std.commonErrors.map((e) => `${e.http}:${e.remedy}`);
    for (const [name, spec] of Object.entries(std.commands)) {
      for (const e of spec.errors) {
        expect(hoisted, `${name} repeats a hoisted row`).not.toContain(
          `${e.http}:${e.remedy}`
        );
      }
    }
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
        relatedCommands: ["ib dev ai conversation"],
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
        relatedCommands: ["ib dev ai conversation"],
      },
    ];
    const projected = projectGlossaryForPrimer(rawItems);
    const std = JSON.stringify(buildReference(undefined, "standard", projected));
    // The hidden command path must NOT appear anywhere in the dump output.
    expect(std).not.toContain("ib dev ai conversation");
    // The term should be present; the definition is intentionally dropped.
    expect(std).toContain('"term":"ai"');
    expect(std).not.toContain("AI assistant interface");
  });
});
