import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { formatHelp, formatGroupHelp } from "../../src/output/help.js";
import { GLOSSARY } from "../../src/reference/domain.js";

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

describe("Rich --help wiring — real command tree", () => {
  const commands = collectCommands(buildProgram());

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
      expect(cmd.helpInformation(), path).toBe(
        formatGroupHelp(path, cmd.description(), COMMAND_SPECS, GLOSSARY)
      );
    }
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
      .filter((p) => !(p.endsWith(" help") && p !== "ib help"));
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
        if (!specFlagLongs.has(long)) drift.push(`${spec.command} ${long}`);
      }
    }
    expect(drift).toEqual([]);
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
