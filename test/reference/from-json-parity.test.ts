import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

/**
 * `--from-json` parity (fb#808).
 *
 * `--from-json` is NOT part of `addWriteFlagsToCommand` — that supplies only the
 * write-safety trio — so it has to be declared per command. CLAUDE.md, the CLI's
 * own shell-mangled-`--body` hint, and several spec descriptions all present it
 * as the universal shell-safe route for a payload on Windows, which is what
 * makes an omission invisible: nothing fails until an unattended run types the
 * flag and gets "unknown option". Three ratchets, each one a real drift that had
 * already happened when they were written:
 *
 *  1. a command with an inline JSON `--body` and no file twin (14 of them);
 *  2. a registered `--from-json` missing from its spec, so `ib reference dump`
 *     and `--help` hide a flag the command accepts;
 *  3. a spec that ADVERTISES `--from-json` in prose for a command that does not
 *     register it — `ib sijainti create`'s `--body` description said "use
 *     --from-json <file|-> there" while the flag did not exist. Nothing caught
 *     it, because `spec-flags-wired.test.ts` reads declared flag ROWS and this
 *     promise lived in a description string.
 */
const program = await buildProgram();

const leaves = new Map<string, Command>();
(function walk(cmd: Command, path: string[]) {
  const full = [...path, cmd.name()].join(" ");
  if (!cmd.commands.length) leaves.set(full, cmd);
  for (const sub of cmd.commands) walk(sub, [...path, cmd.name()]);
})(program, []);

const longs = (cmd: Command): string[] => cmd.options.map((o) => o.long).filter(Boolean) as string[];
const specByPath = new Map(COMMAND_SPECS.map((s) => [s.command, s]));

describe("--from-json parity", () => {
  test("every command with an inline JSON --body also offers --from-json", () => {
    const gaps = [...leaves]
      // `--body <json>` is the whole request payload; `--body <text>` is a prose
      // FIELD. Both are covered here — the flags of a prose command are equally
      // reachable through a --from-json object — so the test keys on the flag
      // being present at all, not on its placeholder.
      .filter(([, cmd]) => longs(cmd).includes("--body") && !longs(cmd).includes("--from-json"))
      .map(([path]) => path);
    expect(gaps, "these commands take a payload with no shell-safe file route").toEqual([]);
  });

  test("every registered --from-json is a documented spec flag", () => {
    const undocumented = [...leaves]
      .filter(([path, cmd]) => {
        if (!longs(cmd).includes("--from-json")) return false;
        const spec = specByPath.get(path);
        // A path with NO spec is an alias of one that has it (`ib feedback
        // create` → `ib dev feedback create`); alias coverage is a different
        // test's job, and specs are deliberately declared once per canonical path.
        return spec ? !spec.flags.some((f) => f.name === "from-json") : false;
      })
      .map(([path]) => path);
    expect(undocumented, "registered but absent from the spec (invisible to `ib reference dump`)").toEqual([]);
  });

  test("no spec advertises --from-json for a command that does not register it", () => {
    const liars: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const cmd = leaves.get(spec.command);
      if (!cmd || longs(cmd).includes("--from-json")) continue;
      const prose = [
        spec.description,
        ...spec.flags.map((f) => f.description ?? ""),
        ...(spec.notes ?? []),
        ...(spec.errors ?? []).map((e) => `${e.meaning} ${e.remedy}`),
      ]
        .join(" ")
        // Backticked spans are stripped first, because a code span NAMES the
        // command it belongs to — "`ib dev feedback create --from-json`" on the
        // `import` spec is a correct cross-reference to a sibling, not a promise
        // about `import`. A BARE mention in prose has no such subject and reads
        // as "this command takes it", which is exactly how `ib sijainti create`
        // came to advertise a flag it did not register.
        .replace(/`[^`]*`/g, " ");
      if (prose.includes("--from-json")) liars.push(spec.command);
    }
    expect(liars, "spec prose names --from-json but the command does not accept it").toEqual([]);
  });
});
