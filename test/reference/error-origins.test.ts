import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintForError, exitCodeFromStatus } from "../../src/api/errors.js";
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

/** A locally-raised failure: `statusCode 0` is what marks a row `origin: "client"`. */
const client4 = (message: string) => new CliError(message, 0, null, 4);

/**
 * A backend failure. The exit comes from `exitCodeFromStatus` rather than a
 * hand-rolled ternary — a local copy silently disagreed with the real mapping
 * for 5xx, which would have quietly mis-set up the first 500-routing assertion
 * anyone added.
 */
const server = (message: string, status: number) =>
  new CliError(message, status, null, exitCodeFromStatus(status));

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

  test("no row's `match` is shadowed by an EARLIER row in the same bucket", () => {
    // Overlapping matchers would reintroduce order-dependence by the back door.
    //
    // Widened twice from the original client-only, exact-equality check:
    //  - HTTP rows share the identical hazard (`matchHttpRow` also takes the
    //    FIRST hit), so the bucket is `http:<status>` OR `client:<exit>`;
    //  - CONTAINMENT, not equality: if every alternative of a later row contains
    //    some alternative of an earlier one, every message reaching the later row
    //    hit the earlier one first, so the later row is unreachable. Equality is
    //    the special case (`a === b` implies `b.includes(a)`), so nothing the old
    //    check caught is lost.
    const alts = (r: CommandError) =>
      r.match === undefined ? [] : [r.match].flat().map((s) => s.toLowerCase());
    const offenders: string[] = [];
    for (const spec of COMMAND_SPECS) {
      const buckets = new Map<string, CommandError[]>();
      for (const row of spec.errors ?? []) {
        const key = row.http !== undefined ? `http:${row.http}` : `client:${row.exit}`;
        buckets.set(key, [...(buckets.get(key) ?? []), row]);
      }
      for (const [key, rows] of buckets) {
        rows.forEach((later, i) => {
          const mine = alts(later);
          if (!mine.length) return;
          const shadowedBy = rows
            .slice(0, i)
            .find((earlier) => {
              const theirs = alts(earlier);
              return theirs.length > 0 && mine.every((m) => theirs.some((t) => m.includes(t)));
            });
          if (shadowedBy)
            offenders.push(
              `${spec.command} :: ${key} — "${later.meaning}" is unreachable behind "${shadowedBy.meaning}"`
            );
        });
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

/**
 * fb#668 follow-up — the CLIENT-side twin of the shadowing above, found by
 * probing the fixed build rather than by reading.
 *
 * `matchClientRow` prefers a row whose `match` hits and otherwise falls back to
 * the command's SOLE matchless client row at that exit. That fallback is
 * deliberate (one client failure needs no substring), but it turns a NARROW sole
 * row into a catch-all: on `sijainti create` the only matchless client row was
 * the --puomi one, so a missing --type AND a failed --geocode were both answered
 * with "pass metres 0–999.99 with min ≤ max".
 *
 * Underneath it sat the same mislabel as fb#280: `--geocode` is resolved
 * CLIENT-side (applyGeocodeToBody geocodes first and failWith(...,4)s on no
 * match, so the write never happens), yet it was documented as `http: 400` —
 * unreachable no matter what the caller does.
 *
 * Deliberately NOT guarded by a test: the only mechanical signal is "a sole
 * matchless client row whose meaning names a flag", which fires on 31 of 85
 * commands, nearly all of them correct. A guard that noisy gets rubber-stamped
 * rather than read (the reasoning that already shaped flag-vocabulary's stem
 * rule), so these are pinned by behaviour instead.
 */
describe("sijainti client-side rows answer their own failure (fb#668 follow-up)", () => {

  test("THE BUG: a failed --geocode is no longer answered with the puomi remedy", () => {
    // Real message, copied from a live probe against production.
    const hint = hintForError(
      client4('could not geocode address "qqqqzzzz nonexistent street" (status: NO_ROUTE_FOUND)'),
      rowsOf("ib sijainti create")
    );
    expect(hint).toMatch(/fuller --address/);
    expect(hint).not.toMatch(/metres/);
  });

  test("a missing required field is answered as a missing required field", () => {
    const hint = hintForError(client4("create requires: --type (sijaintiTypeId)"), rowsOf("ib sijainti create"));
    expect(hint).toMatch(/--name and --type/);
    expect(hint).not.toMatch(/metres/);
  });

  test("the puomi remedy still reaches its OWN failure on all three commands", () => {
    for (const cmd of ["ib sijainti create", "ib sijainti update", "ib sijainti set-jerry"]) {
      expect(hintForError(client4("--puomi-min must be a non-negative number of metres"), rowsOf(cmd))).toMatch(
        /metres/
      );
    }
  });

  test("`--geocode` with no address gets its own remedy on create and update", () => {
    for (const cmd of ["ib sijainti create", "ib sijainti update"]) {
      expect(
        hintForError(client4("--geocode requires --address (or sijaintiOsoite1 in --body)"), rowsOf(cmd))
      ).toMatch(/pass --address/);
    }
  });

  test("set-jerry's --on/--off and --radius guards reach their own row", () => {
    expect(hintForError(client4("Pass exactly one of --on / --off"), rowsOf("ib sijainti set-jerry"))).toMatch(
      /exactly one of --on/
    );
    expect(
      hintForError(client4("--radius must be a positive number of km"), rowsOf("ib sijainti set-jerry"))
    ).toMatch(/km > 0/);
  });

  test("an undocumented client failure now gets NO hint rather than the puomi one", () => {
    // The sole-matchless-row fallback is gone from these commands by design:
    // silence beats confidently wrong advice.
    expect(hintForError(client4("something no ERRORS row documents"), rowsOf("ib sijainti create"))).toBeNull();
  });
});

/**
 * fb#668, third pass — the remaining commands where a NARROW sole client row was
 * acting as `matchClientRow`'s catch-all, plus two more rows mislabeled `http`
 * for a failure the CLI raises locally.
 *
 * Found by a source-coverage audit (guard messages vs documented rows), run as a
 * ONE-OFF rather than added as a test: as a gate it is ~75% false-positive and
 * structurally blind to guards living in shared helpers — which is exactly where
 * the previous round's bug hid. The audit is the right tool; the guard is not.
 */
describe("narrow client rows stop answering for their neighbours (fb#668)", () => {
  test("THE BUG: `keikka update` with no flags is not told to pass a NUMBER", () => {
    // Reproduced live before the fix: the sole matchless row was the
    // "--status must be numeric" one, so "you passed nothing" got "pass a
    // number, e.g. --status 9" — advice for a problem the caller does not have.
    const hint = hintForError(
      client4("Nothing to update: pass --status (v1.0 supports --status only)"),
      rowsOf("ib keikka update")
    );
    expect(hint).toMatch(/only field v1\.0 can update/);
    expect(hint).not.toMatch(/pass a number/);
  });

  test("`keikka update --status abc` still gets the numeric remedy", () => {
    expect(
      hintForError(
        client4('--status must be a numeric keikkaTilaId (e.g. 9 = Toimitettu); got "abc"'),
        rowsOf("ib keikka update")
      )
    ).toMatch(/pass a number/);
  });

  test("`auth impersonate` tells an ALREADY-impersonating caller to END, not start", () => {
    // The sharpest of the set: the old remedy said "start with `ib auth
    // impersonate <personId>`" for a caller whose problem was that a session was
    // already running — the exact opposite instruction.
    const hint = hintForError(
      client4("Already impersonating. Run `ib auth impersonate --end` first."),
      rowsOf("ib auth impersonate")
    );
    expect(hint).toMatch(/--end/);
    expect(hint).not.toMatch(/start with/);
  });

  test("`auth impersonate` with no session still gets the start remedy", () => {
    expect(
      hintForError(client4("No active impersonation session to end."), rowsOf("ib auth impersonate"))
    ).toMatch(/start with/);
  });

  test("both --puomi alternatives are exercised, not just the first", () => {
    // The match array is ["non-negative number of metres", "cannot exceed"] and
    // each alternative corresponds to a DIFFERENT guard line in the source; only
    // the first was covered.
    for (const cmd of ["ib sijainti create", "ib sijainti update", "ib sijainti set-jerry"]) {
      expect(hintForError(client4("--puomi-min must be a non-negative number of metres"), rowsOf(cmd))).toMatch(/metres/);
      expect(hintForError(client4("--puomi-min cannot exceed --puomi-max"), rowsOf(cmd))).toMatch(/metres/);
    }
  });

  test("message body limits are answered as CLIENT errors on both send and edit", () => {
    for (const cmd of ["ib message chat send", "ib message chat edit"]) {
      expect(hintForError(client4("Message body cannot be empty"), rowsOf(cmd))).toMatch(/max 4000/);
      expect(hintForError(client4("Message body too long (max 4000 chars)"), rowsOf(cmd))).toMatch(/max 4000/);
    }
  });

  test("person create's other two exit-4 guards reach their own remedy", () => {
    // Both were missed by af8553e's own audit sweep — its method is only as good
    // as the extraction, and these sat in the tail.
    expect(
      hintForError(client4("--global and --asiakas are mutually exclusive"), rowsOf("ib person create"))
    ).toMatch(/--global for a self-managing person/);
    expect(
      hintForError(
        client4("email x@y.fi is already in use by a person you cannot access (likely owned by another company)."),
        rowsOf("ib person create")
      )
    ).toMatch(/search --my-companies/);
  });

  test("the two previously-undocumented guards now reach a remedy", () => {
    expect(
      hintForError(client4("update requires sijaintiId — pass --id or include it in --body"), rowsOf("ib sijainti update"))
    ).toMatch(/--id <sijaintiId>/);
    expect(hintForError(client4("create requires: --first, --last"), rowsOf("ib person create"))).toMatch(
      /--first and --last/
    );
  });
});
