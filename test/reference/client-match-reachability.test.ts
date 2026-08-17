import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintDetailForError } from "../../src/api/errors.js";
import type { CommandError } from "../../src/output/help.js";
import { resolveGlob } from "../../src/commands/cache/index.js";
import { assertDocVersionLength } from "../../src/commands/legal/index.js";
import { ownerAsiakasIdFromToken } from "../../src/owner.js";
import { createApiClient } from "../../src/api/client.js";

/**
 * fb#672 — a spec client row's `match` is an invisible dependency on the exact
 * wording of a `failWith` that may live in a completely different file. Nothing
 * links them and nothing fails when they diverge; the row just goes dead and the
 * caller silently gets the generic per-status hint. It happened for real in
 * cl#1424, when refactoring `ib dev cache pattern` onto `resolveDualString`
 * changed "missing target:" to "missing glob:".
 *
 * WHY THIS FILE IS NOT THE STATIC SWEEP fb#672 PROPOSED. The row ranked a
 * repo-grep for each `match` substring as "the one worth building first". It was
 * measured before being built, and it does not work:
 *
 *   · Searching all of src/ can NEVER fail — the `match` string is written in
 *     src/reference/specs.ts, so every row trivially finds itself. Run that way
 *     it reports 0 dead rows against any corpus, healthy or not.
 *   · Excluding specs.ts, it reports exactly 2 hits on today's corpus, and BOTH
 *     are false positives caused by template interpolation: `ib dev cache
 *     pattern`'s "missing glob" is really `missing ${positionalName}:`
 *     (targets.ts) and `ib legal save`'s "limited to 20 characters" is really
 *     `limited to ${DOC_VERSION_MAX_LENGTH} characters` (legal/index.ts). Both
 *     rows are live.
 *
 * So the static form is 0 true / 2 false, and every future interpolated guard
 * message adds another false one. This repo has already rejected a guard on
 * exactly those grounds twice — the fb#668 source-coverage audit ("~75%
 * false-positive ... a guard that noisy gets rubber-stamped rather than read",
 * error-origins.test.ts) and flag-vocabulary's deliberate choice of a stem rule
 * over edit distance. It would be inconsistent to add this one.
 *
 * WHAT THIS FILE DOES INSTEAD — fb#672's option (b), aimed at the rows that
 * actually break. A row coupled to a message in its OWN command module is
 * comparatively safe: you are editing the file the spec sits beside. The rows
 * that go stale are the ones whose message lives in a SHARED helper, because
 * that helper gets refactored by someone working on an unrelated command —
 * which is precisely how cl#1424 happened. Those rows are enumerated below and
 * each is driven by invoking the REAL helper, so the assertion is against the
 * message the caller actually receives rather than a copy of it.
 *
 * The contract asserted is the user-visible one: a documented client failure
 * must yield the COMMAND's own remedy, never the generic per-status fallback.
 * Both provenances count as command-specific — `spec` (a matching ERRORS row)
 * and `error` (a remedy carried on the CliError itself, i.e. the `hint`
 * argument of failWith). That distinction matters here: `resolveGlob` passes a
 * hint, so its missing-value failure short-circuits at the `err.hint` branch of
 * hintDetailForError and never reaches matchClientRow at all — a subtlety the
 * static sweep could not have seen either.
 */

function rowsOf(command: string): CommandError[] {
  const spec = COMMAND_SPECS.find((s) => s.command === command);
  if (!spec) throw new Error(`no spec for ${command}`);
  return spec.errors;
}

/** Run a guard that is expected to throw, and hand back the real CliError. */
function raised(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected the guard to throw, but it returned normally");
}

/** The caller-visible outcome: a command-specific remedy, or the generic fallback. */
function remedyFor(err: CliError, command: string) {
  return hintDetailForError(err, rowsOf(command));
}

describe("shared-helper guards still reach their command's own remedy (fb#672)", () => {
  test("`ib dev cache pattern` — a missing glob is answered by the command, not generically", () => {
    // src/targets.ts resolveDualString, reached via cache/index.ts resolveGlob.
    // THE cl#1424 REGRESSION: this message is built as `missing ${positionalName}`,
    // so the wording is owned by a file the cache spec never mentions.
    const err = raised(() => resolveGlob(undefined, undefined));
    expect(err.message.toLowerCase()).toContain("missing glob");

    const { hint, source } = remedyFor(err, "ib dev cache pattern");
    expect(source).not.toBe("generic");
    expect(hint).toBeTruthy();
    expect(hint).toMatch(/cache keys/i);
  });

  test("`ib dev cache pattern` — positional vs --pattern conflict routes to its OWN spec row", () => {
    // The second defect fb#672 found: this path had no matching row at all and
    // had been falling through to the generic hint since it shipped.
    const err = raised(() => resolveGlob("keikka:*", "asiakas:*"));
    expect(err.message.toLowerCase()).toContain("differ");

    const { source } = remedyFor(err, "ib dev cache pattern");
    expect(source).toBe("spec");
  });

  test("`ib legal save` — the interpolated doc-version width guard reaches its row", () => {
    // `limited to ${DOC_VERSION_MAX_LENGTH} characters` — one of the two rows the
    // static sweep falsely condemned. Driving the real guard settles it.
    const err = raised(() => assertDocVersionLength("v".repeat(21)));
    expect(err.message.toLowerCase()).toContain("limited to 20 characters");

    const { source } = remedyFor(err, "ib legal save");
    expect(source).toBe("spec");
  });

  test.each([
    "ib betoni laatu list",
    "ib betoni laatu get",
    "ib betoni attr list",
    "ib betoni attr get",
  ])("%s — owner.ts's shared resolution failure reaches the command's row", (command) => {
    // src/owner.ts owns this wording for four betoni commands whose specs live
    // in a different directory entirely.
    const err = raised(() =>
      ownerAsiakasIdFromToken({ getCurrentToken: () => "not-a-jwt" } as never)
    );
    expect(err.message.toLowerCase()).toContain("could not resolve active company");

    const { source } = remedyFor(err, command);
    expect(source).toBe("spec");
  });

  test.each(["ib dev cache invalidate", "ib dev cache clear", "ib dev cache pattern"])(
    "%s — the client's read-only write-lock reaches the command's row",
    async (command) => {
      // src/api/client.ts. The refusal is raised before any fetch, so this makes
      // no network call.
      const client = createApiClient({
        endpoint: "https://example.invalid",
        token: "t",
        version: "0.0.0-test",
        readOnly: true,
        quiet: true,
      });
      const err = (await client.post("/api/cli/cache/pattern", {}).catch((e) => e)) as CliError;
      expect(err.message.toLowerCase()).toContain("read-only mode is active");

      const { source } = remedyFor(err, command);
      expect(source).toBe("spec");
    }
  );
});

/**
 * The structural half: a `match` that no longer selects its own row is the
 * failure mode, so assert every client row is at least self-consistent — feeding
 * a row's own `match` text back through the real matcher must select THAT row's
 * remedy, not a neighbour's.
 *
 * This does not prove the string matches the live source (nothing mechanical
 * can, see the header), but it does catch the ordering/shadowing class across
 * the whole client-match corpus at zero maintenance cost, and it fails loudly
 * if a future edit makes two rows collide.
 */
// Deliberately count-free: the corpus is derived, so a number in the title goes
// stale the moment anyone adds a `match` row (fb#697 took it 90 -> 121).
describe("every client row with a `match` selects itself", () => {
  const cases: Array<[string, string, number, string]> = [];
  for (const spec of COMMAND_SPECS) {
    for (const row of spec.errors ?? []) {
      if (row.origin !== "client" || row.match === undefined) continue;
      for (const alt of [row.match].flat()) {
        cases.push([spec.command, alt, row.exit, row.remedy ?? ""]);
      }
    }
  }

  test("the corpus is non-empty (a silent zero would make this suite vacuous)", () => {
    expect(cases.length).toBeGreaterThan(80);
  });

  test.each(cases)("%s :: %s", (command, alt, exit, remedy) => {
    const err = new CliError(`prefix ${alt} suffix`, 0, null, exit);
    const { hint, source } = hintDetailForError(err, rowsOf(command));
    expect(source).toBe("spec");
    if (remedy) expect(hint).toBe(remedy);
  });
});
