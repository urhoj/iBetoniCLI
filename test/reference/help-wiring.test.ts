import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { formatHelp } from "../../src/output/help.js";

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

  test("group commands without a spec keep Commander's default help", () => {
    // `ib keikka` is a group with no CommandSpec — its help must NOT be the
    // rich format (it has no single spec to render).
    const group = commands.get("ib keikka");
    expect(group).toBeDefined();
    expect(group!.helpInformation()).toContain("Usage:");
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
});
