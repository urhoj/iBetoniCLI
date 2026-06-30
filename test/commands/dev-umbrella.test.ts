import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { buildDomainIndex, assertKnownDomain } from "../../src/reference/commandsList.js";

function paths(root: Command): Set<string> {
  const set = new Set<string>();
  const walk = (cmd: Command, p: string[]): void => {
    const full = [...p, cmd.name()].join(" ");
    set.add(full);
    for (const sub of cmd.commands) walk(sub, [...p, cmd.name()]);
  };
  walk(root, []);
  return set;
}

const MOVED = ["bug", "feedback", "changelog", "perf", "cache", "schema", "ai", "inbox"];

describe("ib dev umbrella", () => {
  const tree = paths(buildProgram());

  test("canonical paths live under `ib dev`", () => {
    expect(tree.has("ib dev bug")).toBe(true);
    expect(tree.has("ib dev bug get")).toBe(true);
    expect(tree.has("ib dev changelog")).toBe(true);
    expect(tree.has("ib dev inbox")).toBe(true);
    expect(tree.has("ib dev schema")).toBe(true);
  });

  test("old top-level paths still resolve as runtime aliases", () => {
    // Hidden, but still in the command tree → still executable.
    expect(tree.has("ib bug get")).toBe(true);
    expect(tree.has("ib changelog")).toBe(true);
    expect(tree.has("ib inbox")).toBe(true);
  });

  test("domain index shows `dev`, not the 8 old domains (developer tier)", () => {
    const domains = buildDomainIndex(COMMAND_SPECS, "developer").items.map((d) => d.domain);
    expect(domains).toContain("dev");
    for (const d of MOVED) expect(domains).not.toContain(d);
  });

  test("dropped discovery aliases: old domain names exit 4", () => {
    expect(() => assertKnownDomain(COMMAND_SPECS, "bug", "developer")).toThrowError(/unknown domain/);
    expect(() => assertKnownDomain(COMMAND_SPECS, "changelog", "developer")).toThrowError(/unknown domain/);
  });

  test("`dev` is visible at standard tier but shows fewer leaves than at developer", () => {
    const devAt = (tier: "standard" | "developer"): number => {
      const row = buildDomainIndex(COMMAND_SPECS, tier).items.find((d) => d.domain === "dev");
      return row ? row.count : 0;
    };
    // Open leaves (bug create/list/get/comment, feedback create) keep dev visible at standard…
    expect(devAt("standard")).toBeGreaterThan(0);
    // …but developer-only leaves (changelog/schema/perf/ai/cache, feedback list/get/resolve, bug admin) are hidden.
    expect(devAt("standard")).toBeLessThan(devAt("developer"));
  });
});
