import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintForError } from "../../src/api/errors.js";
import type { CommandError } from "../../src/output/help.js";

/**
 * Feedback #289: a spec ERRORS row is matched to a real error by `http`
 * (server-originated) or by `exit` (client-side only), so a server row written
 * without `http` is DEAD — its remedy can never reach the caller, who silently
 * gets the generic per-status hint instead. The `CommandError` union makes the
 * omission a compile error; this file guards the two things the type cannot:
 * rows built dynamically or through a cast, and the specific rows that were
 * found dead.
 */

function rowsOf(command: string): CommandError[] {
  const spec = COMMAND_SPECS.find((s) => s.command === command);
  if (!spec) throw new Error(`no spec for ${command}`);
  return spec.errors;
}

describe("every documented error row declares exactly one origin", () => {
  test("no row omits both `http` and `origin` (dead row), and none declares both", () => {
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      for (const row of spec.errors ?? []) {
        const hasHttp = row.http !== undefined;
        const hasOrigin = row.origin !== undefined;
        if (hasHttp === hasOrigin) {
          offenders.push(`${spec.command} :: exit ${row.exit} — ${row.meaning}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("client rows never carry an http status (they are raised before any request)", () => {
    for (const spec of COMMAND_SPECS) {
      for (const row of spec.errors ?? []) {
        if (row.origin === "client") expect(row.http).toBeUndefined();
      }
    }
  });
});

/**
 * Feedback #305/#306 — the inverse of the dead-row problem above: client rows are
 * matched by EXIT CODE, and exit 4 covers nearly every local guard, so a command
 * with two client exit-4 rows served whichever was listed FIRST to every hintless
 * `failWith(msg, 4)` in that command. `match` binds a row to its own message; this
 * invariant keeps a second ambiguous row from being added without one.
 */
describe("client rows sharing an exit code are disambiguated by `match`", () => {
  test("no spec has two client rows at the same exit without `match` on each", () => {
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const byExit = new Map<number, CommandError[]>();
      for (const row of spec.errors ?? []) {
        if (row.origin !== "client") continue;
        byExit.set(row.exit, [...(byExit.get(row.exit) ?? []), row]);
      }
      for (const [exit, rows] of byExit) {
        if (rows.length < 2) continue;
        for (const row of rows) {
          if (row.match === undefined)
            offenders.push(`${spec.command} :: exit ${exit} — ${row.meaning}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a `match` string actually appears in no OTHER row's match at the same exit", () => {
    // Overlapping matchers would reintroduce order-dependence by the back door.
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const rows = (spec.errors ?? []).filter((r) => r.origin === "client");
      for (const a of rows) {
        for (const b of rows) {
          if (a === b || a.exit !== b.exit) continue;
          const as = a.match === undefined ? [] : [a.match].flat();
          const bs = b.match === undefined ? [] : [b.match].flat();
          if (as.some((x) => bs.some((y) => x.toLowerCase() === y.toLowerCase())))
            offenders.push(`${spec.command} :: exit ${a.exit} — duplicate match`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The four rows the fb#289 audit missed: each documents a SERVER response but was
// written as a bare `{ exit }`, so the command's own remedy was unreachable.
describe("previously dead rows now reach their own remedy", () => {
  test.each(["ib reference detail delete", "ib reference detail lint"])(
    "%s answers a real 403 with its developer-access remedy, not the generic one",
    (command) => {
      const hint = hintForError(new CliError("Forbidden", 403, null, 3), rowsOf(command));
      expect(hint).toMatch(/isDeveloper/i);
      expect(hint).not.toMatch(/check the PERMISSIONS line/i);
    }
  );

  test.each(["ib jerry coverage", "ib jerry email-activity"])(
    "%s separates the local not-logged-in guard from a server 401",
    (command) => {
      const rows = rowsOf(command);
      expect(hintForError(new CliError("Not logged in", 0, null, 2), rows)).toMatch(/auth login/i);
      expect(hintForError(new CliError("Unauthorized", 401, null, 2), rows)).toMatch(/auth refresh/i);
    }
  );
});

// The three mis-hints reproduced live while investigating fb#305.
describe("ambiguous client rows no longer serve an unrelated remedy", () => {
  const client4 = (message: string) => new CliError(message, 0, null, 4);

  test("`ib commands` unknown domain is not answered with the --mutations/--reads remedy", () => {
    const hint = hintForError(
      client4("unknown domain: nosuchdomain. Valid: attachment, auth, ..."),
      rowsOf("ib commands")
    );
    expect(hint).toMatch(/valid domains/i);
    expect(hint).not.toMatch(/mutually exclusive/i);
  });

  test("`ib commands` bad flag combo still gets its own remedy", () => {
    const hint = hintForError(
      client4("--mutations and --reads are mutually exclusive"),
      rowsOf("ib commands")
    );
    expect(hint).toMatch(/mutually exclusive/i);
  });

  test("`jerry check-address` bad --asiakas is not answered with the boom remedy", () => {
    const hint = hintForError(
      client4("--asiakas must be a positive integer"),
      rowsOf("ib jerry check-address")
    );
    expect(hint).toMatch(/--explain/i);
    expect(hint).not.toMatch(/metres/i);
  });

  test("`changelog add` over-length field is not answered with the argv remedy (fb#305)", () => {
    const hint = hintForError(
      client4("value too long — --impact is 505 chars (max 500); shorten to fit the devChangelog column"),
      rowsOf("ib dev changelog add")
    );
    expect(hint).not.toMatch(/instead of argv/i);
  });

  test("an undocumented guard gets NO hint rather than an arbitrary one", () => {
    expect(
      hintForError(client4("something no ERRORS row documents"), rowsOf("ib dev changelog add"))
    ).toBeNull();
  });
});
