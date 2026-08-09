import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { canonicalPath } from "../../src/reference/aliasPaths.js";
import { commandPath } from "../../src/output/unknownCommand.js";
import { CliError, hintForError } from "../../src/api/errors.js";

/**
 * The parse-time guard surface, snapshotted.
 *
 * A guard that runs during PARSE (an option/argument `argParser` calling
 * `failWith`) throws before the preAction hook, so until fb#385 its envelope
 * could never carry the running command's ERRORS remedy. Now that it can, the
 * risk flips: `matchClientRow`'s exit-only fallback will happily serve a
 * command's single client/exit-4 row to a flag-type error it does not document
 * ("--owner must be an integer" → "ib log types"). That is invisible in review —
 * the row is correct, the plumbing is correct, only the pairing is wrong.
 *
 * So enumerate the whole surface: every leaf × every argParser that throws,
 * probed with values that trip it, resolved through the REAL hint pipeline.
 * The snapshot makes each pairing a reviewed decision — a new guard, a new
 * ERRORS row, or a changed `match` shows up here as a diff.
 *
 * Refresh deliberately (`npx vitest run -u`) and READ the diff: a line moving
 * from "(no hint)" to a remedy that does not answer the message is the bug this
 * guards against.
 */
describe("parse-time guard → hint pairing", () => {
  test("every argParser guard resolves a hint that answers its own message", async () => {
    const program = await buildProgram(); // full tree
    const lines: string[] = [];

    const record = (cmd: Command, flag: string, parse: (v: string) => unknown): void => {
      const spec = COMMAND_SPECS.find((s) => s.command === canonicalPath(commandPath(cmd)));
      const seen = new Set<string>();
      for (const probe of ["abc", "-5", ""]) {
        let err: unknown;
        try {
          parse(probe);
          continue;
        } catch (e) {
          err = e;
        }
        if (!(err instanceof CliError) || seen.has(err.message)) continue;
        seen.add(err.message);
        const hint = hintForError(err, spec?.errors ?? null);
        lines.push(
          `${commandPath(cmd)} ${flag}\n  ! ${err.message}\n  > ${hint ?? "(no hint)"}`
        );
      }
    };

    const walk = (cmd: Command): void => {
      if (cmd.commands.length) {
        cmd.commands.forEach(walk);
        return;
      }
      for (const opt of cmd.options) {
        if (typeof opt.parseArg === "function") {
          record(cmd, opt.flags, (v) => opt.parseArg!(v, undefined));
        }
      }
      for (const arg of cmd.registeredArguments) {
        if (typeof arg.parseArg === "function") {
          record(cmd, `<${arg.name()}>`, (v) => arg.parseArg!(v, undefined));
        }
      }
    };
    walk(program);

    // Guard the guard: if the probes ever stop tripping anything, the snapshot
    // would silently shrink to nothing and still "pass".
    expect(lines.length).toBeGreaterThan(40);
    expect(lines.sort().join("\n\n")).toMatchSnapshot();
  });
});
