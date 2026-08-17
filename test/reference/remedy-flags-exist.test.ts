import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { globalFlagsSummary } from "../../src/globals.js";

/**
 * Every flag named in an ERRORS `remedy` must actually exist.
 *
 * A remedy is the one place the CLI tells a stuck caller what to DO, so a
 * remedy naming a flag that does not exist is worse than no remedy at all: the
 * generic per-status hint at least does not send anyone hunting for something
 * unimplementable. fb#697 added 31 `--limit` remedies in one sweep and seven of
 * them named flags the command does not have (`--from`/`--to` on the six
 * cursor-less log routes, and `--situation`/`--ceased` on `customer dead-list`,
 * which exist nowhere in the CLI at all) — written from the shape of a sibling
 * command rather than from the spec's own `flags`. Nothing caught it, because
 * every other guard checks that a remedy is REACHABLE, not that it is TRUE.
 *
 * ATTRIBUTION IS DELIBERATELY PERMISSIVE. A remedy routinely, and correctly,
 * points at a sibling: "use `ib log range --from/--to` to reach older rows" is
 * advice about another command, not a claim about this one. Those references
 * appear in every delimiter style there is — backticked, single-quoted, and
 * bare prose ("ib auth impersonate --end"), sometimes with the command named
 * AFTER the flag ("`--asiakas <id>` (on `person get`)"). Trying to bind each
 * flag to the nearest command produced 14 false positives on rows that were all
 * fine. So the rule is simply: if a remedy names another command anywhere, that
 * command's flags are accepted too. Measured over the whole corpus, that costs
 * nothing — it still isolates exactly the seven wrong rows out of 1286.
 *
 * Globals come from {@link globalFlagsSummary} rather than a local list, so a
 * new global can never make this suite go falsely red. `--help`/`--version` are
 * Commander built-ins on every command; the write-safety trio is added by
 * `addWriteFlagsToCommand` and so is accepted wherever the spec sets
 * `writeFlags`.
 */
const GLOBAL_FLAGS = new Set([
  ...(globalFlagsSummary().match(/--[a-z][a-z0-9-]*/gi) ?? []).map((f) => f.slice(2)),
  "help",
  "version",
]);

/** Attached per-command by `addWriteFlagsToCommand`, never listed in `flags`. */
const WRITE_SAFETY_FLAGS = ["dry-run", "idempotency-key", "reason"];

const SPEC_BY_COMMAND = new Map(COMMAND_SPECS.map((s) => [s.command, s]));
/** Longest first, so `ib log by-entity-date` is preferred over `ib log`. */
const COMMAND_PATHS = [...SPEC_BY_COMMAND.keys()].sort((a, b) => b.length - a.length);

/** The flag names one command accepts, ignoring globals. */
function flagsOf(command: string): string[] {
  const spec = SPEC_BY_COMMAND.get(command);
  const names = (spec?.flags ?? []).map((f) => f.name);
  return spec?.writeFlags ? [...names, ...WRITE_SAFETY_FLAGS] : names;
}

/** Flag names a remedy on `command` is allowed to mention. */
function acceptedFlags(command: string, remedy: string): Set<string> {
  const allowed = new Set([...GLOBAL_FLAGS, ...flagsOf(command)]);
  for (const other of COMMAND_PATHS) {
    if (other !== command && remedy.includes(other)) {
      for (const f of flagsOf(other)) allowed.add(f);
    }
  }
  return allowed;
}

describe("every ERRORS remedy names only flags that exist (fb#697 follow-up)", () => {
  const cases: Array<[command: string, remedy: string]> = [];
  for (const spec of COMMAND_SPECS) {
    for (const row of spec.errors ?? []) {
      if (!row.remedy) continue;
      // `<cmd>` / `<command>` is a placeholder for "whatever command you ran",
      // so there is no spec to check its flags against.
      if (/<cmd>|<command>/.test(row.remedy)) continue;
      cases.push([spec.command, row.remedy]);
    }
  }

  test("the corpus is non-empty (a silent zero would make this suite vacuous)", () => {
    expect(cases.length).toBeGreaterThan(1000);
  });

  test.each(cases)("%s", (command, remedy) => {
    const allowed = acceptedFlags(command, remedy);
    const unknown = [
      ...new Set((remedy.match(/--[a-z][a-z0-9-]*/gi) ?? []).map((f) => f.slice(2))),
    ].filter((f) => !allowed.has(f));
    expect(unknown.map((f) => `--${f}`)).toEqual([]);
  });
});
