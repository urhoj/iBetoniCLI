import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { buildCommandsList, buildDomainIndex, assertKnownDomain } from "../../src/reference/commandsList.js";
import { buildReference } from "../../src/reference/dump.js";
import { canonicalPath, DEV_ALIAS_DOMAINS } from "../../src/reference/aliasPaths.js";

/** Render a command's --help from the real wired tree, as Commander would. */
function helpFor(root: Command, path: string): string {
  const parts = path.split(" ").slice(1); // drop "ib"
  let cmd: Command | undefined = root;
  for (const name of parts) {
    cmd = cmd?.commands.find((c) => c.name() === name);
    if (!cmd) throw new Error(`not in tree: ${path}`);
  }
  return cmd!.helpInformation();
}

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

// The alias set has ONE definition (src/reference/aliasPaths.ts) — the same
// table that drives the hidden registrations and resolves alias paths back to
// their specs. This test used to keep its own copy.
const MOVED: readonly string[] = DEV_ALIAS_DOMAINS;

// No argv hint → the full tree, which is what these tree-shape assertions want.
const fullProgram = await buildProgram();

describe("ib dev umbrella", () => {
  const tree = paths(fullProgram);

  test("canonical paths live under `ib dev`", () => {
    expect(tree.has("ib dev changelog")).toBe(true);
    expect(tree.has("ib dev inbox")).toBe(true);
    expect(tree.has("ib dev schema")).toBe(true);
  });

  test("old top-level paths still resolve as runtime aliases", () => {
    // Hidden, but still in the command tree → still executable.
    expect(tree.has("ib changelog")).toBe(true);
    expect(tree.has("ib inbox")).toBe(true);
  });

  test("domain index shows `dev`, not the 7 old domains (developer tier)", () => {
    const domains = buildDomainIndex(COMMAND_SPECS, "developer").items.map((d) => d.domain);
    expect(domains).toContain("dev");
    for (const d of MOVED) expect(domains).not.toContain(d);
  });

  test("old domain names stay out of the index but resolve as subgroup discovery aliases", () => {
    expect(() => assertKnownDomain(COMMAND_SPECS, "bug", "developer")).toThrowError(/unknown domain/);
    const changelog = buildCommandsList({ domain: "changelog" }, "developer");
    expect(changelog.items.map((i) => i.command)).toContain("ib dev changelog add");
    expect(changelog.items.every((i) => i.command.startsWith("ib dev changelog "))).toBe(true);
  });

  test("reference dump resolves old subgroup aliases too, like `ib commands` (feedback #137)", () => {
    // `ib reference dump changelog` must mirror `ib commands changelog`, not throw
    // `unknown domain` — both surfaces resolve the bare `dev` subgroup alias.
    const cmds = Object.keys(buildReference("changelog", "developer").commands);
    expect(cmds).toContain("ib dev changelog add");
    expect(cmds.every((c) => c.startsWith("ib dev changelog "))).toBe(true);
    // A genuinely unknown token still throws exit-4.
    expect(() => buildReference("bug", "developer")).toThrowError(/unknown domain/);
  });

  test("canonicalPath maps alias paths to their spec path and leaves others alone", () => {
    expect(canonicalPath("ib feedback create")).toBe("ib dev feedback create");
    expect(canonicalPath("ib changelog")).toBe("ib dev changelog");
    // the `ib opendata` re-homing rides the same table
    expect(canonicalPath("ib weather forecast")).toBe("ib opendata weather forecast");
    expect(canonicalPath("ib customer prh")).toBe("ib opendata prh");
    // already canonical, unrelated, and too-short paths pass through untouched
    expect(canonicalPath("ib dev feedback create")).toBe("ib dev feedback create");
    expect(canonicalPath("ib opendata weather forecast")).toBe("ib opendata weather forecast");
    expect(canonicalPath("ib keikka list")).toBe("ib keikka list");
    expect(canonicalPath("ib")).toBe("ib");
  });

  test("matching is word-boundary aware — a longer name sharing the prefix is untouched", () => {
    expect(canonicalPath("ib weatherx")).toBe("ib weatherx");
    expect(canonicalPath("ib aid list")).toBe("ib aid list");
    expect(canonicalPath("ib customer prhx")).toBe("ib customer prhx");
    expect(canonicalPath("ib customer list")).toBe("ib customer list");
  });

  test("an alias LEAF renders the same rich help as its canonical path", () => {
    // Regression: attachRichHelp matched specs by literal path, so alias leaves
    // fell through to bare Commander help — losing PERMISSIONS / OUTPUT /
    // ERRORS / EXAMPLES, i.e. the whole "help is self-contained for an AI"
    // contract. Group help was patched for this; leaves were not.
    const root = fullProgram;
    for (const [alias, canonical] of [
      ["ib feedback create", "ib dev feedback create"],
      ["ib changelog add", "ib dev changelog add"],
      ["ib schema tables", "ib dev schema tables"],
      ["ib weather forecast", "ib opendata weather forecast"],
      ["ib customer prh", "ib opendata prh"],
    ] as const) {
      expect(helpFor(root, alias)).toBe(helpFor(root, canonical));
      // and it really is the rich rendering, not two identical bare renders
      expect(helpFor(root, alias)).toMatch(/^USAGE\n/);
    }
  });

  test("`dev` is visible at standard tier but shows fewer leaves than at developer", () => {
    const devAt = (tier: "standard" | "developer"): number => {
      const row = buildDomainIndex(COMMAND_SPECS, tier).items.find((d) => d.domain === "dev");
      return row ? row.count : 0;
    };
    // Open leaves (feedback create) keep dev visible at standard…
    expect(devAt("standard")).toBeGreaterThan(0);
    // …but developer-only leaves (changelog/schema/perf/ai/cache, feedback list/get/resolve) are hidden.
    expect(devAt("standard")).toBeLessThan(devAt("developer"));
  });
});
