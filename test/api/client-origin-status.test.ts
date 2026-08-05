import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

/**
 * The source-side twin of `test/reference/error-origins.test.ts`.
 *
 * That file guards the SPEC half of the origin contract (every ERRORS row
 * declares `http` or `origin`); this one guards the CODE half: a `CliError`
 * the CLI raises itself — a flag guard, a parse failure, a "not in the fetched
 * list" miss — MUST carry `statusCode: 0`, because that is the only value
 * `hintForError` treats as client-origin (`matchClientRow` runs solely for
 * `statusCode === 0`).
 *
 * ~49 guards used to hand-build `new CliError(msg, 400, null, 4)` instead.
 * The cost was threefold: the JSON envelope reported a status no server sent,
 * the command's own `origin:"client"` remedy became unreachable, and the fake
 * status could match an unrelated `http: 400` spec row. Prefer `failWith(msg,
 * exit)` / `failUsage(msg)` — they set `statusCode: 0` for you.
 *
 * Scope: `src/`, minus `src/api/` (where a non-zero status is the whole point —
 * `client.ts` translates a real HTTP response) and minus co-located
 * `__tests__/`, whose fixtures deliberately simulate server responses.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Directories under `src/` where a non-zero statusCode is legitimate. */
const EXEMPT_DIRS = ["api", "__tests__"];

function tsFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!EXEMPT_DIRS.includes(entry)) tsFilesUnder(path, out);
    } else if (path.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Second argument of every `new CliError(` in `source`, found by balancing
 * brackets from the opening paren (the calls are routinely multi-line, and the
 * message argument is usually a template literal full of commas and braces, so
 * a regex over the call text is not good enough).
 */
export function statusArgsOf(source: string): { status: string; line: number }[] {
  const found: { status: string; line: number }[] = [];
  const NEEDLE = "new CliError(";
  for (let at = source.indexOf(NEEDLE); at !== -1; at = source.indexOf(NEEDLE, at + 1)) {
    const argsStart = at + NEEDLE.length;
    const commas: number[] = [];
    let depth = 1;
    let quote: string | null = null;
    let i = argsStart;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i];
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) commas.push(i);
    }
    if (commas.length === 0) continue;
    const end = commas.length > 1 ? commas[1] : i - 1;
    found.push({
      status: source.slice(commas[0] + 1, end).trim(),
      line: source.slice(0, at).split("\n").length,
    });
  }
  return found;
}

describe("locally-raised CliErrors are client-origin", () => {
  test("no `new CliError(msg, <non-zero literal>, …)` outside src/api", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const { status, line } of statusArgsOf(source)) {
        // Only a NUMERIC LITERAL is a fabrication. A propagated `e.statusCode`
        // (the rewrap idiom in refHint.ts / auth/impersonate.ts, where a real
        // response WAS received) is exactly right and must stay allowed.
        if (/^\d+$/.test(status) && status !== "0") {
          offenders.push(`${relative(SRC, file).split(sep).join("/")}:${line} → statusCode ${status}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scanner recognises the shapes it is guarding against", () => {
    // Single-line, multi-line, and template-literal-with-commas forms.
    const sample = [
      'throw new CliError("flat", 400, null, 4);',
      "throw new CliError(\n  `--x must be one of: ${A.join(\", \")}`,\n  404,\n  null,\n  5\n);",
      "throw new CliError(msg, 0, null, 4);",
      "throw new CliError(e.message, e.statusCode, e.body, e.exitCode);",
    ].join("\n");
    expect(statusArgsOf(sample).map((s) => s.status)).toEqual([
      "400",
      "404",
      "0",
      "e.statusCode",
    ]);
  });
});
