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

/**
 * fb#668 — the SERVER-side twin of the dead-row rule above.
 *
 * `matchHttpRow` narrows to the rows sharing the error's status, prefers one
 * whose `match` substring hits, and otherwise falls back to
 * `rows.find(r => r.match === undefined)`. That fallback can only ever return
 * ONE row, so a second matchless row at the same status is unreachable — its
 * remedy is dead and the first row answers every occurrence of that status.
 *
 * Nothing fails when this happens; the caller just gets the wrong advice. It
 * reached 14 commands before anyone read the matcher, which is exactly how
 * fb#280/#289 went. The rule is exact rather than heuristic, so it is worth
 * enforcing rather than re-auditing.
 *
 * The fix for a real second cause is a `match` substring on the NARROW row
 * (leaving the general row as the catch-all) — not reordering, which the
 * matcher ignores.
 */
describe("no spec shadows one of its own error rows (fb#668)", () => {
  test("at most ONE matchless row per HTTP status, per command", () => {
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const matchless = new Map<number, CommandError[]>();
      for (const row of spec.errors ?? []) {
        if (row.http === undefined || row.match !== undefined) continue;
        if (!matchless.has(row.http)) matchless.set(row.http, []);
        matchless.get(row.http)!.push(row);
      }
      for (const [http, rows] of matchless) {
        if (rows.length < 2) continue;
        offenders.push(
          `${spec.command} :: HTTP ${http} — ${rows.length} matchless rows, only "${rows[0].meaning}" is reachable ` +
            `(dead: ${rows.slice(1).map((r) => `"${r.meaning}"`).join(", ")})`
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the repaired rows are genuinely reachable, not just annotated", () => {
    // A `match` that does not correspond to the backend's real text would pass
    // the structural check above while remaining just as dead, so assert the
    // actual routing for the cases fb#668 repaired.
    const server = (msg: string, status: number) =>
      new CliError(msg, status, null, status === 403 ? 3 : status === 404 ? 5 : 4);

    // Cross-tenant vehicle read vs a plain permission denial.
    expect(
      hintForError(server("no vehicle access on the requested company", 403), rowsOf("ib vehicle get"))
    ).toMatch(/vehicle-manage role/);
    expect(hintForError(server("Permission denied", 403), rowsOf("ib vehicle get"))).toMatch(
      /auth\.page\.vehicle\.read/
    );

    // The isPublic admin gate speaks Finnish; matching is case-insensitive.
    expect(
      hintForError(
        server("Vain yrityksen ylläpitäjä voi muuttaa sijainnin julkisuutta", 403),
        rowsOf("ib sijainti set-public")
      )
    ).toMatch(/ask a company admin/);
    expect(hintForError(server("Permission denied", 403), rowsOf("ib sijainti set-public"))).toMatch(
      /auth\.page\.sijainnit\.edit/
    );

    // Two 404s whose text differs only in the parenthetical.
    expect(
      hintForError(
        server("glossary term 'puomi' not found (append/add/remove requires an existing term)", 404),
        rowsOf("ib glossary set")
      )
    ).toMatch(/Create the term first/);
    expect(
      hintForError(server("glossary term 'puomi' not found (update-only)", 404), rowsOf("ib glossary set"))
    ).toMatch(/Omit --update-only/);
  });

  test("the empty-patch guard is answered as a CLIENT error, not a backend 400", () => {
    // It is raised by failWith(..., 4) before any request, so an `http: 400`
    // row could never match it — and while it sat there it also shadowed the
    // real 400.
    const hint = hintForError(
      new CliError(
        "update requires at least one field: typed flags (--name/--num/...) or a --body/--from-json JSON patch",
        0,
        null,
        4
      ),
      rowsOf("ib worksite update")
    );
    expect(hint).toMatch(/at least one typed flag/);
  });
});
