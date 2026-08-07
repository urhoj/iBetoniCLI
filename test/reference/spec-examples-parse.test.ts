import { describe, test, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram, enableParserThrow } from "../../src/program.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";

/**
 * Spec examples are the primary copy-paste surface an AI invokes verbatim
 * (leaf `--help`, `ib reference dump`, the AI primer), so a malformed one is
 * run as-is and dies at the parser. `dump.test.ts` asserts every spec HAS
 * examples; this file asserts they PARSE. Static and offline — actions are
 * replaced with no-ops, so nothing reaches the network (feedback #292).
 *
 * Three failure modes are checked per example:
 *  1. it parses at all (unknown flag/command, missing required flag or
 *     positional, typo'd subcommand);
 *  2. no option or positional swallowed an option-like token as its VALUE —
 *     Commander does NOT reject `--body --oops`, it silently sets
 *     body="--oops" (the fb#278 near-miss that prompted this guard);
 *  3. it invokes its OWN spec's command, and that command is runnable (a leaf,
 *     not a bare group) — catches an example that silently resolves elsewhere,
 *     e.g. through a hidden back-compat alias root.
 */

/** Specs whose examples deliberately name a DIFFERENT command. */
const CROSS_COMMAND_EXAMPLES = new Set([
  // Rename stub: the command only emits "renamed to `ib validate`", so its
  // examples must show the replacement, not the dead path.
  "ib company validate",
]);

/** Split a command line into argv, honouring '…' and "…" quoting. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Extract the `ib …` argv from an example, dropping any shell pipeline around
 * it (`… | jq '…'`, `echo '…' | ib glossary import -`). Returns null when no
 * segment starts with `ib`.
 */
export function ibArgv(example: string): string[] | null {
  const segments: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of example) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "|") {
      segments.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  for (const segment of segments) {
    const tokens = tokenize(segment.trim());
    if (tokens[0] === "ib") return tokens.slice(1);
  }
  return null;
}

function fullPath(cmd: Command): string {
  const parts: string[] = [];
  let cur: Command | null = cmd;
  while (cur) {
    parts.unshift(cur.name());
    cur = cur.parent ?? null;
  }
  return parts.join(" ");
}

/**
 * A value that looks like a flag almost certainly means the preceding option
 * ate the next flag instead of a real value. Bare `-` is legitimate (stdin,
 * e.g. `ib glossary import -`).
 */
function looksLikeFlag(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("-") && value !== "-";
}

interface ParseResult {
  /** Full path of the command whose action fired, e.g. "ib keikka list". */
  invoked: string | null;
  /** True when the resolved command has subcommands (i.e. is not runnable). */
  invokedIsGroup: boolean;
  /** Options/positionals that swallowed an option-like token as their value. */
  swallowed: string[];
}

/**
 * Parse `argv` against the real command tree with every action replaced by a
 * recorder. Throws whatever Commander throws on a usage error.
 */
async function parseExample(argv: string[]): Promise<ParseResult> {
  const program = await buildProgram(argv);
  const result: ParseResult = { invoked: null, invokedIsGroup: false, swallowed: [] };
  // Neuter EVERY command (groups included) so no action can reach the network.
  // A bare-group example therefore parses instead of erroring — the
  // `invokedIsGroup` assertion below is what catches that case.
  const neuter = (cmd: Command): void => {
    cmd.action(function (this: Command, ...actionArgs: unknown[]) {
      result.invoked = fullPath(this);
      result.invokedIsGroup = this.commands.length > 0;
      for (const [name, value] of Object.entries(this.optsWithGlobals())) {
        if (looksLikeFlag(value)) result.swallowed.push(`--${name}=${value}`);
      }
      this.registeredArguments.forEach((arg, i) => {
        if (looksLikeFlag(actionArgs[i])) {
          result.swallowed.push(`<${arg.name()}>=${String(actionArgs[i])}`);
        }
      });
    });
    cmd.commands.forEach(neuter);
  };
  neuter(program);
  enableParserThrow(program);
  await program.parseAsync(["node", "ib", ...argv]);
  return result;
}

/** `--help` / `--version` exit through exitOverride with code 0 — not errors. */
function isCleanExit(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "commander.helpDisplayed" || code === "commander.version";
}

describe("every CommandSpec example is invocable as written", () => {
  let totalExamples = 0;

  for (const spec of COMMAND_SPECS) {
    test(`${spec.command}: examples parse`, async () => {
      for (const example of spec.examples) {
        totalExamples++;
        const argv = ibArgv(example);
        expect(argv, `${spec.command}: example has no \`ib …\` segment: ${example}`).toBeTruthy();

        let parsed: ParseResult;
        try {
          parsed = await parseExample(argv!);
        } catch (err) {
          if (isCleanExit(err)) continue;
          throw new Error(`${spec.command} — example does not parse:\n  ${example}\n  ${(err as Error).message}`);
        }

        expect(parsed.swallowed, `${spec.command} — example ate a flag as an option value:\n  ${example}`).toEqual([]);
        expect(parsed.invokedIsGroup, `${spec.command} — example resolves to a GROUP, not a runnable command:\n  ${example}`).toBe(false);
        if (!CROSS_COMMAND_EXAMPLES.has(spec.command)) {
          expect(parsed.invoked, `${spec.command} — example invokes a different command:\n  ${example}`).toBe(spec.command);
        }
      }
    });
  }

  test("the suite actually checked the whole example corpus", () => {
    // Guards against a vacuous pass if examples stop being enumerated.
    expect(totalExamples).toBeGreaterThan(600);
  });
});

describe("the example harness catches real breakage", () => {
  // Without this, a change that stops the parser from throwing would turn the
  // suite above green-but-blind.
  test.each([
    ["unknown command", ["nosuchcommand"]],
    ["unknown flag", ["company", "list", "--nope"]],
    ["missing required flag", ["customer", "person", "add", "--person", "1"]],
    ["missing required positional", ["attachment", "get"]],
    ["typo'd subcommand", ["keikka", "lst"]],
  ])("%s → parse error", async (_label, argv) => {
    await expect(parseExample(argv as string[])).rejects.toThrow();
  });

  test("option-like value is caught by the swallowed-value check, not by parse", async () => {
    // Commander accepts this: it only errors when the value is ABSENT, never
    // when it looks like a flag. Parsing alone would miss it.
    const parsed = await parseExample(["dev", "feedback", "create", "--description", "--oops"]);
    expect(parsed.swallowed).toEqual(["--description=--oops"]);
  });

  test("a bare group is reported as not runnable", async () => {
    const parsed = await parseExample(["keikka"]);
    expect(parsed.invokedIsGroup).toBe(true);
  });
});
