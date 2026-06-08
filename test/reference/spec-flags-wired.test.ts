import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

/** Map "ib customer search" → its Commander Command by walking the tree. */
function indexCommands(root: Command): Map<string, Command> {
  const out = new Map<string, Command>();
  const walk = (cmd: Command, path: string[]): void => {
    const full = [...path, cmd.name()].join(" ");
    out.set(full, cmd);
    for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
  };
  walk(root, []);
  return out;
}

/** Collect all --long option names on a command AND all its ancestors (global flags). */
function allLongsIncludingAncestors(cmd: Command): Set<string> {
  const longs = new Set<string>();
  let cur: Command | null = cmd;
  while (cur) {
    for (const opt of cur.options) {
      if (opt.long) longs.add(opt.long);
    }
    cur = cur.parent ?? null;
  }
  return longs;
}

describe("every documented spec flag is a registered Commander option", () => {
  const program = buildProgram();
  const byPath = indexCommands(program);

  for (const spec of COMMAND_SPECS) {
    test(`${spec.command}: all flags wired`, () => {
      const cmd = byPath.get(spec.command);
      expect(cmd, `no registered command for "${spec.command}"`).toBeTruthy();
      // Positional arguments are declared in specs as flags (documentation
      // convenience) but are NOT Commander options — exclude them so the guard
      // only fires on genuine unwired --option flags.
      const positionalNames = new Set(
        (cmd as Command).registeredArguments.map((a) => a.name())
      );
      // Also include global/ancestor options so specs that document global flags
      // (e.g. --endpoint on `ib version`) don't produce false positives.
      const longs = allLongsIncludingAncestors(cmd as Command);
      const missing = spec.flags
        .map((f) => `--${f.name}`)
        .filter((long) => {
          const name = long.slice(2); // strip "--"
          if (positionalNames.has(name)) return false; // skip positionals
          return !longs.has(long);
        });
      expect(missing, `${spec.command} declares unwired flags`).toEqual([]);
    });
  }
});
