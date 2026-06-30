import { describe, test, expect } from "vitest";
import { buildProgram } from "../../src/program.js";
import {
  levenshtein,
  closestName,
  visibleSubcommands,
  buildUnknownCommandEnvelope,
} from "../../src/output/unknownCommand.js";

const legalOf = () => {
  const program = buildProgram();
  return program.commands.find((c) => c.name() === "legal")!;
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
    const std = visibleSubcommands(buildProgram(), "standard");
    expect(std).not.toContain("schema");
    expect(std).not.toContain("ai");
    expect(std).not.toContain("changelog");
    expect(std).toContain("keikka");
    // dev umbrella is the canonical path at standard (has standard-visible leaves)
    expect(std).toContain("dev");
  });
  test("developer tier keeps the dev umbrella at root (not the old hidden aliases)", () => {
    const names = visibleSubcommands(buildProgram(), "developer");
    expect(names).toContain("dev");
    // back-compat aliases are still Commander-hidden even at developer tier
    expect(names).not.toContain("schema");
    expect(names).not.toContain("ai");
  });
});
