import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import {
  levenshtein,
  closestName,
  visibleSubcommands,
  buildUnknownCommandEnvelope,
  buildUnknownOptionEnvelope,
  buildExcessArgumentsEnvelope,
  asDateSuggestion,
  dateFlagSuggestion,
  siblingsAcceptingOption,
  OPTION_REDIRECTS,
} from "../../src/output/unknownCommand.js";

// Sibling enumeration and did-you-mean read the WHOLE tree, so build it once
// with no argv hint and inspect it — these assertions never mutate the program.
const program = await buildProgram();

const legalOf = () => program.commands.find((c) => c.name() === "legal")!;

/** Walk the built program tree to a leaf command by its path (after `ib`). */
const leafByPath = (...path: string[]): Command => {
  let cmd: Command = program;
  for (const name of path) cmd = cmd.commands.find((c) => c.name() === name)!;
  return cmd;
};

describe("levenshtein / closestName (#1)", () => {
  test("edit distance", () => {
    expect(levenshtein("active", "active")).toBe(0);
    expect(levenshtein("actve", "active")).toBe(1);
    expect(levenshtein("verison", "versions")).toBe(3);
  });
  test("closestName suggests a near match, null when nothing is close", () => {
    expect(closestName("actve", ["active", "status", "versions"])).toBe("active");
    expect(closestName("verison", ["versions", "drafts"])).toBe("versions");
    expect(closestName("xyzzy", ["active", "status"])).toBeNull();
  });
  test("prefix wins", () => {
    expect(closestName("acc", ["accept", "acceptances", "active"])).toBe("accept");
  });
  test("verb-synonym fallback add↔create, show/view→get (#229)", () => {
    expect(closestName("add", ["create", "list"])).toBe("create");
    expect(closestName("create", ["add", "list"])).toBe("add");
    expect(closestName("show", ["get", "list"])).toBe("get");
    expect(closestName("view", ["get", "list"])).toBe("get");
    // the synonym only helps when the canonical sibling is actually present
    expect(closestName("add", ["list", "resolve"])).toBeNull();
    // an edit-distance near-match still wins over the synonym table
    expect(closestName("add", ["aad", "create"])).toBe("aad");
  });
});

describe("buildUnknownCommandEnvelope (#1)", () => {
  test("lists legal siblings + suggests the closest (developer tier)", () => {
    const env = buildUnknownCommandEnvelope(legalOf(), "verison", "developer");
    expect(env.code).toBe("USAGE");
    expect(env.statusCode).toBe(0);
    expect(env.group).toBe("ib legal");
    expect(env.unknownCommand).toBe("verison");
    expect(env.available).toContain("active");
    expect(env.available).toContain("versions");
    expect(env.didYouMean).toBe("versions");
    expect(env.hint).toContain("ib legal --help");
  });
  test("`list` token (an alias, not a near sibling-name) → no suggestion", () => {
    // `list` is an ALIAS of `active` post-#3, so a real `ib legal list` routes
    // to active and never reaches this builder; passed directly here it has no
    // near canonical-sibling match, so didYouMean is null.
    const env = buildUnknownCommandEnvelope(legalOf(), "list", "developer");
    expect(env.didYouMean).toBeNull();
    expect(env.available).toContain("active");
  });
  test("standard tier hides developer-only siblings (save/activate/delete/...)", () => {
    const env = buildUnknownCommandEnvelope(legalOf(), "save", "standard");
    expect(env.available).not.toContain("save");
    expect(env.available).not.toContain("acceptances");
    expect(env.available).toContain("active");
  });
  test("verb synonym surfaces in the envelope: `add` on a create-group → create (#229)", () => {
    const keikka = program.commands.find((c) => c.name() === "keikka")!;
    const env = buildUnknownCommandEnvelope(keikka, "add", "developer");
    expect(env.available).toContain("create");
    expect(env.didYouMean).toBe("create");
    expect(env.hint).toContain("ib keikka create");
  });
});

describe("buildUnknownOptionEnvelope (#235/#236)", () => {
  test("names the command's positionals + accepted flags; USAGE/exit shape", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "search"), "--qeury");
    expect(env.code).toBe("USAGE");
    expect(env.statusCode).toBe(0);
    expect(env.command).toBe("ib customer search");
    expect(env.unknownOption).toBe("--qeury");
    // query is now an optional positional (Part 2) → rendered with brackets.
    expect(env.positionals).toContain("[<query>]");
    expect(env.availableOptions).toContain("--search");
    expect(env.availableOptions).toContain("--limit");
    expect(env.hint).toContain("ib customer search --help");
  });

  test("fuzzy did-you-mean among the command's real flags", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "create"), "--nam");
    expect(env.didYouMean).toBe("--name");
    expect(env.hint).toContain("Did you mean `--name`?");
  });

  test("no near flag → didYouMean null (no misleading suggestion)", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("keikka", "list"), "--zzzzzz");
    expect(env.didYouMean).toBeNull();
  });

  test("curated cross-command redirect: cache invalidate --pattern → `cache pattern`", () => {
    const env = buildUnknownOptionEnvelope(
      leafByPath("dev", "cache", "invalidate"),
      "--pattern"
    );
    expect(env.command).toBe("ib dev cache invalidate");
    expect(env.positionals).toContain("<entityType>");
    expect(env.hint).toContain("ib dev cache pattern");
    expect(env.hint).toContain("<entityType> positional");
    // write-safety flags surface as accepted flags for a mutating command.
    expect(env.availableOptions).toContain("--reason");
  });

  test("OPTION_REDIRECTS is keyed by full command path + flag", () => {
    expect(OPTION_REDIRECTS).toHaveProperty("ib dev cache invalidate --pattern");
  });
});

// feedback #308 — the reported invocation was a dead end: `ib person list
// --search Vilenius` rejected the flag, offered didYouMean:null, and never
// named `ib person search`, which owns exactly that capability.
describe("sibling-command flag redirect (#308)", () => {
  test("the reported case: person list --search names `ib person search`", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--search");
    expect(env.acceptedBy).toEqual(["ib person search"]);
    expect(env.hint).toContain("`ib person search`");
    expect(env.hint).toContain("owns this capability");
  });

  test("derived from specs, so it generalises beyond the reported domain", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "get"), "--search");
    expect(env.acceptedBy).toContain("ib customer search");
  });

  test("a leaf named after the flag beats catalogue order", () => {
    const { acceptedBy } = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--search");
    expect(acceptedBy[0]).toBe("ib person search");
  });

  test("no sibling accepts it → empty, and no invented suggestion", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--zzzzzz");
    expect(env.acceptedBy).toEqual([]);
    expect(env.hint).not.toContain("sibling");
  });

  test("stays within the domain — never points at another domain's command", () => {
    const { acceptedBy } = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--search");
    expect(acceptedBy.every((c) => c.startsWith("ib person "))).toBe(true);
  });

  test("a curated redirect wins — the derived list stays empty", () => {
    const env = buildUnknownOptionEnvelope(
      leafByPath("dev", "cache", "invalidate"),
      "--pattern"
    );
    expect(env.acceptedBy).toEqual([]);
    expect(env.hint).toContain("ib dev cache pattern");
  });

  test("sibling enumeration is tier-gated (developer-only leaves stay hidden)", () => {
    const devOnly = siblingsAcceptingOption("ib dev feedback create", "--status", "developer");
    const standard = siblingsAcceptingOption("ib dev feedback create", "--status", "standard");
    expect(devOnly.length).toBeGreaterThan(0); // feedback list/resolve take --status
    expect(standard).toEqual([]); // …and are tier:"developer"
  });
});

describe("asDateSuggestion (#328)", () => {
  test("normalizes the forms a caller actually types to YYYY-MM-DD", () => {
    expect(asDateSuggestion("2026-08-06")).toBe("2026-08-06");
    expect(asDateSuggestion("20260806")).toBe("2026-08-06"); // both captured instances
    expect(asDateSuggestion("6.8.2026")).toBe("2026-08-06");
    expect(asDateSuggestion("06.08.2026")).toBe("2026-08-06");
  });

  test("passes through the relative keywords resolveDate accepts", () => {
    expect(asDateSuggestion("today")).toBe("today");
    expect(asDateSuggestion("Yesterday")).toBe("yesterday");
  });

  // A wrong suggestion is worse than none, so the bar is "obviously a date".
  test("rejects non-dates and impossible calendar dates", () => {
    for (const t of ["52", "abc", "", "2026", "123456789", "20261338", "2026-02-31", "0.0.2026"]) {
      expect(asDateSuggestion(t), t).toBeNull();
    }
  });
});

describe("buildExcessArgumentsEnvelope (#328)", () => {
  test("a date positional on an `<id> --date` command suggests the flag, normalized", () => {
    const env = buildExcessArgumentsEnvelope(
      leafByPath("vehicle", "timeline"),
      ["20260806"],
      "too many arguments for 'timeline'. Expected 1 argument but got 2: 52, 20260806."
    );
    expect(env.didYouMean).toBe("--date 2026-08-06");
    expect(env.hint).toContain("--date 2026-08-06");
    expect(env.hint).toContain("YYYY-MM-DD"); // the input format was also wrong
    expect(env.hint).toContain("<vehicleId>");
    expect(env.code).toBe("USAGE");
    expect(env.statusCode).toBe(0);
  });

  test("an already-ISO date suggests the flag without nagging about format", () => {
    const env = buildExcessArgumentsEnvelope(
      leafByPath("vehicle", "timeline"),
      ["2026-08-06"],
      "too many arguments"
    );
    expect(env.didYouMean).toBe("--date 2026-08-06");
    expect(env.hint).not.toContain("documented format");
  });

  test("a non-date surplus falls back to the shell-splitting explanation", () => {
    const env = buildExcessArgumentsEnvelope(
      leafByPath("vehicle", "timeline"),
      ["banana"],
      "too many arguments"
    );
    expect(env.didYouMean).toBeNull();
    expect(env.hint).toMatch(/PowerShell/);
    expect(env.hint).toContain("<vehicleId>");
  });

  test("still lists the command's real positionals and flags", () => {
    const env = buildExcessArgumentsEnvelope(leafByPath("vehicle", "timeline"), ["x"], "e");
    expect(env.availableOptions).toContain("--date");
    expect(env.positionals.length).toBeGreaterThan(0);
  });
});

// Commander reports a missing mandatory option BEFORE excess positionals, so on
// a command with a required flag the date hint was computed but never reached —
// the same validation-ordering masking fb#309 hit with unknown options. Found by
// probing `ib message daily get 5 today` (--asiakas is required there).
describe("dateFlagSuggestion — shared by both parse-error paths (#328)", () => {
  test("suggests the date flag for a surplus date token", () => {
    expect(dateFlagSuggestion(leafByPath("message", "daily", "get"), ["today"])).toBe("--date today");
    expect(dateFlagSuggestion(leafByPath("vehicle", "timeline"), ["20260806"])).toBe(
      "--date 2026-08-06"
    );
  });

  test("null when the command declares no date flag, or nothing looks like a date", () => {
    expect(dateFlagSuggestion(leafByPath("vehicle", "timeline"), ["banana"])).toBeNull();
    expect(dateFlagSuggestion(leafByPath("customer", "search"), ["2026-08-06"])).toBeNull();
  });

  test("takes the excess tokens as a parameter so both call sites agree", () => {
    // Guards the refactor trap: the builder must not re-derive tokens from an
    // unparsed Command (which would silently yield null in every unit test).
    const cmd = leafByPath("vehicle", "route");
    expect(dateFlagSuggestion(cmd, [])).toBeNull();
    expect(dateFlagSuggestion(cmd, ["6.8.2026"])).toBe("--date 2026-08-06");
  });
});

describe("verb aliases (#229)", () => {
  const leafOf = (group: string, leaf: string) => {
    const g = program.commands.find((c) => c.name() === group)!;
    return g.commands.find((c) => c.name() === leaf)!;
  };
  test("`feedback create` answers to `add`", () => {
    expect(leafOf("feedback", "create").aliases()).toContain("add");
  });
  test("`changelog add` answers to `create` (reciprocal)", () => {
    expect(leafOf("changelog", "add").aliases()).toContain("create");
  });
});

describe("visibleSubcommands (#1)", () => {
  test("developer sees all legal leaves incl. dev-tier", () => {
    expect(visibleSubcommands(legalOf(), "developer")).toContain("save");
  });
});

describe("visibleSubcommands root tier-hiding (#1)", () => {
  test("back-compat aliases (schema/ai/changelog) hidden via Commander at root at both tiers", () => {
    // Hidden Commander commands are filtered regardless of tier — they are
    // runtime-only aliases absent from spec-driven discovery and root --help.
    const std = visibleSubcommands(program, "standard");
    expect(std).not.toContain("schema");
    expect(std).not.toContain("ai");
    expect(std).not.toContain("changelog");
    expect(std).toContain("keikka");
    // dev umbrella is the canonical path at standard (has standard-visible leaves)
    expect(std).toContain("dev");
  });
  test("developer tier keeps the dev umbrella at root (not the old hidden aliases)", () => {
    const names = visibleSubcommands(program, "developer");
    expect(names).toContain("dev");
    // back-compat aliases are still Commander-hidden even at developer tier
    expect(names).not.toContain("schema");
    expect(names).not.toContain("ai");
  });
});
