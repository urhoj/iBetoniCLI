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
});
