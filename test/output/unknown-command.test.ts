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
  test("`list` (no near match) → siblings, no suggestion", () => {
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
  test("standard tier hides fully-developer domains at root (schema/ai/changelog)", () => {
    const names = visibleSubcommands(buildProgram(), "standard");
    expect(names).not.toContain("schema");
    expect(names).not.toContain("ai");
    expect(names).not.toContain("changelog");
    expect(names).toContain("keikka");
  });
  test("developer tier keeps the developer-only domains at root", () => {
    expect(visibleSubcommands(buildProgram(), "developer")).toContain("schema");
  });
});
