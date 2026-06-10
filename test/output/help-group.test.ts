import { describe, test, expect } from "vitest";
import { formatGroupHelp } from "../../src/output/help.js";
import type { CommandSpec } from "../../src/output/help.js";
import type { GlossaryEntry } from "../../src/reference/domain.js";

const SPECS: CommandSpec[] = [
  {
    command: "ib keikka list",
    description: "List concrete delivery orders. Flat envelope for AI consumption.",
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
  {
    command: "ib keikka get",
    description: "Get a single keikka by id.",
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
  {
    command: "ib keikka drivers list",
    description: "List a keikka's drivers.",
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
  {
    command: "ib other thing",
    description: "Unrelated.",
    flags: [],
    outputShape: "{}",
    errors: [],
    examples: [],
  },
];

const GLOSSARY_SAMPLE: GlossaryEntry[] = [
  { term: "keikka", definition: "A concrete delivery/pumping order." },
];

describe("formatGroupHelp", () => {
  const out = formatGroupHelp("ib keikka", "Keikka commands", SPECS, GLOSSARY_SAMPLE);

  test("renders USAGE for the group", () => {
    expect(out).toContain("USAGE");
    expect(out).toContain("ib keikka <command> [flags]");
  });

  test("blurb comes from the matching glossary term", () => {
    expect(out).toContain("A concrete delivery/pumping order.");
  });

  test("lists direct leaf children with first-sentence descriptions", () => {
    expect(out).toContain("SUBCOMMANDS");
    expect(out).toContain("list");
    // first sentence only — the second sentence must be truncated away
    expect(out).toContain("List concrete delivery orders.");
    expect(out).not.toContain("Flat envelope");
    expect(out).toContain("Get a single keikka by id.");
  });

  test("marks subgroup children and points at their --help", () => {
    expect(out).toContain("drivers");
    expect(out).toContain("ib keikka drivers --help");
  });

  test("excludes other domains' commands", () => {
    expect(out).not.toContain("Unrelated");
  });

  test("footer points to the domain dump, per-command help, and concept guides", () => {
    expect(out).toContain("ib reference dump keikka");
    expect(out).toContain("--help");
    expect(out).toContain("ib help");
  });

  test("falls back to the Commander description when no glossary term matches", () => {
    const noMatch = formatGroupHelp("ib other", "Other commands", SPECS, GLOSSARY_SAMPLE);
    expect(noMatch).toContain("Other commands");
  });

  test("nested group uses its domain (first token) for the dump pointer", () => {
    const nested = formatGroupHelp(
      "ib keikka drivers",
      "Driver assignment commands",
      SPECS,
      GLOSSARY_SAMPLE
    );
    expect(nested).toContain("ib keikka drivers <command> [flags]");
    expect(nested).toContain("ib reference dump keikka");
    expect(nested).toContain("List a keikka's drivers.");
  });
});
