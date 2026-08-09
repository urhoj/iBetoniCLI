import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import {
  levenshtein,
  closestName,
  visibleSubcommands,
  buildUnknownCommandEnvelope,
  buildUnknownOptionEnvelope,
  truncateOptionToken,
  prosePrefixHint,
  buildExcessArgumentsEnvelope,
  asDateSuggestion,
  dateFlagSuggestion,
  siblingsAcceptingOption,
  siblingGroupsWithCommand,
  descendantsOwningVerb,
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

// feedback #388 — semantic flag guesses edit distance cannot bridge.
describe("flag synonyms (fb#388)", () => {
  test("the reported case: customer search --query resolves to --search", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "search"), "--query");
    expect(env.didYouMean).toBe("--search");
    expect(env.hint).toContain("Did you mean `--search`?");
  });

  test("the synonym never invents a flag the command does not accept", () => {
    // `keikka list` has no --search, so --query must NOT resolve to one.
    const env = buildUnknownOptionEnvelope(leafByPath("keikka", "list"), "--query");
    expect(env.availableOptions).not.toContain("--search");
    expect(env.didYouMean).not.toBe("--search");
  });

  test("a real near-match still beats the synonym table", () => {
    // --qeury is one transposition from --query… but --search is the only
    // search-ish flag here, so the fuzzy path (not the table) must answer.
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "search"), "--limitt");
    expect(env.didYouMean).toBe("--limit");
  });

  test("synonym-matched siblings are reported with the spelling they accept", () => {
    // `person list` accepts neither --query nor --search; `person search` owns
    // the capability, under --search.
    const env = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--query");
    expect(env.acceptedBy).toEqual(["ib person search"]);
    expect(env.acceptedAs).toBe("--search");
    expect(env.hint).toContain("`--search`");
    expect(env.hint).toContain("ib person search");
  });

  test("acceptedAs is absent when the siblings accept the flag verbatim", () => {
    const env = buildUnknownOptionEnvelope(leafByPath("person", "list"), "--search");
    expect(env.acceptedBy).toEqual(["ib person search"]);
    expect(env.acceptedAs).toBeUndefined();
  });

  test("a same-command did-you-mean suppresses the sibling redirect", () => {
    // customer search owns --search itself: answer here, don't send them away.
    const env = buildUnknownOptionEnvelope(leafByPath("customer", "search"), "--query");
    expect(env.acceptedBy).toEqual([]);
    expect(env.acceptedAs).toBeUndefined();
  });

  test("the two renamed outliers now accept the majority spelling (fb#388)", () => {
    const cache = buildUnknownOptionEnvelope(leafByPath("dev", "cache", "invalidate"), "--zzz");
    expect(cache.availableOptions).toContain("--asiakas");
    expect(cache.availableOptions).not.toContain("--asiakas-id");

    const searches = buildUnknownOptionEnvelope(
      leafByPath("jerry", "admin", "searches", "list"),
      "--zzz"
    );
    expect(searches.availableOptions).toContain("--search");
    expect(searches.availableOptions).not.toContain("--q");
  });
});

// feedback #343 — `ib company get 8` dead-ended on a group that has no `get`,
// while `ib customer get 8` (the same asiakas) is exactly what was wanted.
describe("sibling-GROUP subcommand redirect (#343)", () => {
  const companyOf = () => program.commands.find((c) => c.name() === "company")!;

  test("the reported case: company/get → ib customer get", () => {
    const env = buildUnknownCommandEnvelope(companyOf(), "get", "developer");
    expect(env.availableElsewhere).toEqual(["ib customer get"]);
    expect(env.hint).toContain("`ib customer get` does");
    // the in-group list is still reported, as context behind the answer
    expect(env.available).toEqual(["list", "current", "switch"]);
  });

  test("only fires when the sibling command really exists", () => {
    expect(siblingGroupsWithCommand("ib company", "get", "developer")).toEqual([
      { path: "ib customer get", why: expect.stringContaining("asiakas") },
    ]);
    expect(siblingGroupsWithCommand("ib company", "nosuch", "developer")).toEqual([]);
    // …and the envelope invents nothing for an unrelated token
    const env = buildUnknownCommandEnvelope(companyOf(), "nosuch", "developer");
    expect(env.availableElsewhere).toEqual([]);
    expect(env.hint).not.toContain("ib customer");
  });

  test("declared pairs only — an undeclared domain never redirects", () => {
    // `ib customer get` exists, but keikka is not paired with customer, so a
    // cross-domain guess is not offered (every domain owns a `get`).
    expect(siblingGroupsWithCommand("ib keikka", "get", "developer")).toEqual([]);
    // nested groups are not domain pairs either
    expect(siblingGroupsWithCommand("ib jerry offer", "get", "developer")).toEqual([]);
  });

  test("the pair is declared both ways", () => {
    expect(siblingGroupsWithCommand("ib customer", "switch", "developer")).toEqual([
      { path: "ib company switch", why: expect.any(String) },
    ]);
  });

});

describe("descendant-subgroup verb redirect (fb#379)", () => {
  test("the audited dead-ends now point at the owning subgroup", () => {
    expect(descendantsOwningVerb("ib keikka", "assign", "developer")).toEqual([
      "ib keikka drivers assign",
    ]);
    expect(descendantsOwningVerb("ib vehicle", "assign", "developer")).toEqual([
      "ib vehicle driver assign",
    ]);
    expect(descendantsOwningVerb("ib message", "archive", "developer")).toEqual([
      "ib message thread archive",
    ]);
  });

  test("envelope carries the redirect, copy-paste runnable with the caller's args", () => {
    const keikka = program.commands.find((c) => c.name() === "keikka")!;
    keikka.args = ["assign", "92", "tomorrow"];
    const env = buildUnknownCommandEnvelope(keikka, "assign", "developer");
    keikka.args = [];
    expect(env.availableElsewhere).toEqual(["ib keikka drivers assign"]);
    expect(env.hint).toContain("`ib keikka drivers assign 92 tomorrow` does");
  });

  test("fires at the root for a SPECIFIC verb (fb#383)", () => {
    // the reported case: `ib dashboard` left the caller guessing among 29 groups
    expect(descendantsOwningVerb("ib", "dashboard", "developer")).toEqual([
      "ib worksite dashboard",
      "ib sijainti dashboard",
    ]);
    expect(descendantsOwningVerb("ib", "assign", "developer")).toEqual([
      "ib keikka drivers assign",
      "ib vehicle driver assign",
    ]);
  });

  test("stays silent at the root for a GENERIC verb — every domain owns one", () => {
    // ~28 owners: naming an arbitrary few would displace the domain list + `ib
    // commands` advice, which IS the right answer for a bare CRUD verb.
    for (const verb of ["list", "get", "create", "delete", "search", "clear"]) {
      expect(descendantsOwningVerb("ib", verb, "developer")).toEqual([]);
    }
  });

  test("root envelope carries the redirect and names the owning domains", () => {
    const env = buildUnknownCommandEnvelope(program, "dashboard", "developer");
    expect(env.availableElsewhere).toEqual(["ib worksite dashboard", "ib sijainti dashboard"]);
    expect(env.hint).toContain("`ib worksite dashboard`, `ib sijainti dashboard`");
    // …without claiming a group the caller never typed
    expect(env.hint).not.toContain("this group");
    expect(env.available).toContain("worksite");
  });

  test("root scan is tier-gated too", () => {
    // all three `stats` owners are developer-tier (jerry admin / dev cache / dev perf)
    expect(descendantsOwningVerb("ib", "stats", "developer")).toEqual([
      "ib jerry admin request stats",
      "ib dev cache stats",
      "ib dev perf stats",
    ]);
    expect(descendantsOwningVerb("ib", "stats", "standard")).toEqual([]);
  });

  test("a direct sibling is not re-suggested (depth-1 is already `available`)", () => {
    expect(descendantsOwningVerb("ib keikka", "list", "developer")).toEqual([]);
  });

  test("tier-gated: a developer-only descendant is invisible below its tier", () => {
    // `ib jerry admin request stats` is developer-tier; standard callers get nothing.
    expect(descendantsOwningVerb("ib jerry", "stats", "developer")).toContain(
      "ib jerry admin request stats"
    );
    expect(descendantsOwningVerb("ib jerry", "stats", "standard")).toEqual([]);
  });

  test("the curated pair still wins over the descendant scan", () => {
    const company = program.commands.find((c) => c.name() === "company")!;
    const env = buildUnknownCommandEnvelope(company, "get", "developer");
    expect(env.availableElsewhere).toEqual(["ib customer get"]);
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
    expect(dateFlagSuggestion(leafByPath("message", "daily", "get"), ["today"])).toEqual({
      suggestion: "--date today", token: "today", date: "today",
    });
    expect(dateFlagSuggestion(leafByPath("vehicle", "timeline"), ["20260806"])).toEqual({
      suggestion: "--date 2026-08-06", token: "20260806", date: "2026-08-06",
    });
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
    expect(dateFlagSuggestion(cmd, ["6.8.2026"])?.suggestion).toBe("--date 2026-08-06");
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

describe("unknown option — alias identity and prose tokens (fb#342 / fb#359)", () => {
  test("truncateOptionToken flattens and clamps a prose block", () => {
    const prose = "--severity means two different things in two commands\n\n" + "x".repeat(500);
    const out = truncateOptionToken(prose);
    expect(out.length).toBeLessThanOrEqual(81); // 80 + the ellipsis
    expect(out).not.toContain("\n");
    expect(out.endsWith("…")).toBe(true);
  });

  test("truncateOptionToken leaves a real flag untouched", () => {
    expect(truncateOptionToken("--search")).toBe("--search");
  });

  test("prosePrefixHint fires on whitespace and names --description", () => {
    const [hint] = prosePrefixHint("--severity means two things", ["--description", "--from-json"]);
    expect(hint).toMatch(/reads as prose rather than a flag/);
    expect(hint).toMatch(/--description/);
    expect(hint).toMatch(/--from-json/);
  });

  test("prosePrefixHint stays silent for a genuine unknown flag", () => {
    expect(prosePrefixHint("--serverity", ["--description"])).toEqual([]);
  });

  test("prosePrefixHint does not advertise --description on a command lacking it", () => {
    const [hint] = prosePrefixHint("--foo bar baz", ["--limit"]);
    expect(hint).toMatch(/reads as prose/);
    expect(hint).not.toMatch(/--description/);
  });
});
