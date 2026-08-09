import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { formatHelp, formatGroupHelp } from "../../src/output/help.js";
import { ALIAS_PREFIXES } from "../../src/reference/aliasPaths.js";

/** Collect every leaf+group command in the tree as its full path → Command. */
function collectCommands(root: Command): Map<string, Command> {
  const map = new Map<string, Command>();
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    map.set(full, cmd);
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
  return map;
}

// No argv hint → every domain registered, which is what "every spec maps to a
// registered command" needs.
const fullProgram = await buildProgram();

describe("Rich --help wiring — real command tree", () => {
  const commands = collectCommands(fullProgram);

  test("every COMMAND_SPEC maps to a registered command", () => {
    const orphaned = COMMAND_SPECS.map((s) => s.command).filter(
      (c) => !commands.has(c)
    );
    expect(orphaned).toEqual([]);
  });

  test("each spec'd command's --help emits the rich formatHelp output", () => {
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      expect(cmd, `command not found: ${spec.command}`).toBeDefined();
      expect(cmd!.helpInformation()).toBe(formatHelp(spec));
    }
  });

  test("non-root group commands render computed group help", () => {
    for (const [path, cmd] of commands) {
      if (path === "ib" || cmd.commands.length === 0) continue;
      const parent = path.split(" ").slice(0, -1);
      const groupAliases = cmd.aliases().map((a) => [...parent, a].join(" "));
      expect(cmd.helpInformation(), path).toBe(
        formatGroupHelp(path, cmd.description(), COMMAND_SPECS, "developer", groupAliases)
      );
    }
  });

  // Commander resolves an alias to the canonical command and then every surface
  // reports the CANONICAL name, so `ib legal list --type X` answered "unknown
  // option on `ib legal active`" — a command the caller never typed (feedback
  // #342). `spec.aliases` is what `formatHelp` and the unknown-option envelope
  // use to bridge the two names, so it has to mirror the wiring exactly: an
  // undeclared `.alias()` silently reinstates the identity swap, and a declared
  // alias that is not wired advertises a command that exits 4.
  test("spec.aliases matches the registered Commander .alias() calls", () => {
    const drift: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      if (!cmd) continue; // covered by the orphan test above
      const parent = spec.command.split(" ").slice(0, -1);
      const wired = cmd.aliases().map((a) => [...parent, a].join(" ")).sort();
      const declared = [...(spec.aliases ?? [])].sort();
      if (wired.join("|") !== declared.join("|")) {
        drift.push(`${spec.command}: wired=[${wired.join(", ")}] spec=[${declared.join(", ")}]`);
      }
    }
    expect(drift).toEqual([]);
    // Not vacuous: the known aliased leaves must actually be carrying one.
    expect(COMMAND_SPECS.filter((s) => s.aliases?.length).length).toBeGreaterThanOrEqual(5);
  });

  test("each spec'd command's Commander description equals spec.description", () => {
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      expect(cmd, `command not found: ${spec.command}`).toBeDefined();
      expect(cmd!.description(), spec.command).toBe(spec.description);
    }
  });

  test("every leaf command has a CommandSpec (no undocumented commands)", () => {
    const specPaths = new Set(COMMAND_SPECS.map((s) => s.command));
    const leaves = [...commands.entries()]
      .filter(([, cmd]) => cmd.commands.length === 0) // leaf = no subcommands
      .map(([path]) => path)
      .filter((p) => p !== "ib") // root is not a leaf command
      // Commander auto-adds a `help` subcommand to each GROUP (e.g. "ib keikka help");
      // those are framework-generated and legitimately specless. Our own top-level
      // `ib help` (depth 1) DOES have a spec and must NOT be excluded.
      .filter((p) => !(p.endsWith(" help") && p !== "ib help"))
      // Hidden back-compat alias leaves (the `ib opendata` and `ib dev`
      // re-homings): the canonical spec lives at the other end of the mapping,
      // so these paths are intentionally spec-less — they still run, but vanish
      // from spec-driven discovery. Derived from the shared alias table so the
      // exclusions can never drift from what `canonicalPath` actually resolves.
      .filter(
        (p) => !ALIAS_PREFIXES.some(([alias]) => p === alias || p.startsWith(alias + " "))
      );
    const missing = leaves.filter((p) => !specPaths.has(p));
    // Guard against vacuous test: ensure we are actually checking a meaningful number of leaves.
    expect(leaves.length).toBeGreaterThan(80);
    expect(missing).toEqual([]);
  });

  // Reverse direction (Commander → spec): the tests above catch spec entries
  // with no command, but not wired options missing from the spec. Without this,
  // a flag can work at runtime yet be invisible in --help / reference dump
  // (e.g. `vehicle list --cursor`, `person day set` write-safety block).
  const WRITE_SAFETY_LONGS = ["--dry-run", "--idempotency-key", "--reason"];

  /**
   * Hidden back-compat flag aliases (`new Option(...).hideHelp()`) → the
   * documented flag each stands in for (fb#388: two naming outliers renamed to
   * the majority spelling, old argv still accepted).
   *
   * These are deliberately spec-less, which is precisely the state the drift
   * test below exists to catch — so the exemption is paired with an exact-match
   * assertion here. A new hidden option that is not listed fails, a listed row
   * whose option disappeared fails, and an alias standing in for a flag the spec
   * does NOT document fails. "Hidden" can therefore never mean "undocumented
   * capability", only "second spelling of a documented one".
   */
  const DEPRECATED_FLAG_ALIASES: Record<string, string> = {
    "ib dev cache invalidate --asiakas-id": "--asiakas",
    "ib jerry admin searches list --q": "--search",
  };

  const isHidden = (opt: { hidden?: boolean }): boolean => !!opt.hidden;

  test("every wired Commander option appears in the spec (flags or write-safety block)", () => {
    const drift: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      if (!cmd) continue; // covered by the orphan test above
      const specFlagLongs = new Set(spec.flags.map((f) => `--${f.name}`));
      for (const opt of cmd.options) {
        const long = opt.long;
        if (!long || long === "--help") continue;
        if (WRITE_SAFETY_LONGS.includes(long) && spec.writeFlags) continue;
        if (isHidden(opt)) continue; // pinned by the alias test below
        if (!specFlagLongs.has(long)) drift.push(`${spec.command} ${long}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("every hidden flag alias is declared and stands in for a documented flag", () => {
    const found: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      if (!cmd) continue;
      const specFlagLongs = new Set(spec.flags.map((f) => `--${f.name}`));
      for (const opt of cmd.options) {
        if (!opt.long || !isHidden(opt)) continue;
        const key = `${spec.command} ${opt.long}`;
        found.push(key);
        const canonical = DEPRECATED_FLAG_ALIASES[key];
        expect(canonical, `${key} is hidden but undeclared in DEPRECATED_FLAG_ALIASES`).toBeTruthy();
        expect(
          specFlagLongs.has(canonical),
          `${key} stands in for ${canonical}, which this command's spec does not document`
        ).toBe(true);
      }
    }
    // Exact match both ways — no unlisted hidden option, no stale row.
    expect(found.sort()).toEqual(Object.keys(DEPRECATED_FLAG_ALIASES).sort());
  });

  test("no subcommand option collides with a root global option", () => {
    // Commander recognises root options ANYWHERE in argv, so a root global
    // (e.g. the old global `--asiakas`) SHADOWS any same-named subcommand
    // option — a required local flag becomes unsatisfiable (usage error even
    // when supplied). Regression guard for the --asiakas → --company rename.
    const root = [...commands.values()].find((c) => c.name() === "ib");
    const rootLongs = new Set(root!.options.map((o) => o.long).filter(Boolean));
    const collisions: string[] = [];
    for (const [path, cmd] of commands) {
      if (path === "ib") continue;
      for (const opt of cmd.options) {
        if (opt.long && opt.long !== "--help" && rootLongs.has(opt.long)) {
          collisions.push(`${path} ${opt.long}`);
        }
      }
    }
    expect(rootLongs.size).toBeGreaterThan(5); // not vacuous
    expect(collisions).toEqual([]);
  });

  test("commands wiring the full write-safety trio declare writeFlags in their spec", () => {
    const drift: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = commands.get(spec.command);
      if (!cmd) continue;
      const longs = new Set(cmd.options.map((o) => o.long));
      const hasTrio = WRITE_SAFETY_LONGS.every((l) => longs.has(l));
      if (hasTrio && !spec.writeFlags) drift.push(spec.command);
    }
    expect(drift).toEqual([]);
  });
});
