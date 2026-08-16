import { describe, test, expect } from "vitest";
import {
  CliError,
  exitCodeForError,
  hintDetailForError,
  hintForError,
} from "../../src/api/errors.js";
import { failUsage } from "../../src/output/json.js";

describe("exitCodeForError", () => {
  test("returns the CliError's mapped exitCode (preserves the contract)", () => {
    expect(exitCodeForError(new CliError("denied", 403, null, 3))).toBe(3);
    expect(exitCodeForError(new CliError("missing", 404, null, 5))).toBe(5);
    expect(exitCodeForError(new CliError("boom", 500, null, 6))).toBe(6);
    expect(exitCodeForError(new CliError("net", 0, null, 7))).toBe(7);
  });

  test("falls back to 1 for a non-CliError", () => {
    expect(exitCodeForError(new Error("plain"))).toBe(1);
    expect(exitCodeForError("string error")).toBe(1);
  });
});

describe("hintForError — 404 deploy-gate disambiguation", () => {
  test("code:ROUTE_NOT_FOUND yields the not-deployed hint (overrides a spec remedy)", () => {
    const err = new CliError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }, 5);
    const specErrors = [{ http: 404, exit: 5, meaning: "Not found", remedy: "no keikka with that id" }];
    const hint = hintForError(err, specErrors);
    expect(hint).toMatch(/not deployed/i);
    expect(hint).not.toMatch(/no keikka/);
  });

  test("a plain 404 (no code) yields the resource-not-found hint", () => {
    const err = new CliError("Not found", 404, { code: null }, 5);
    const hint = hintForError(err, null);
    expect(hint).toMatch(/no such resource/i);
  });

  // feedback #280: the generic 404 hint used to assert "the id likely does not
  // exist in the ACTIVE company". Plenty of 404s are on GLOBAL resources (command
  // catalog, glossary, reference data) where that is a false lead, so tenancy may
  // only be offered conditionally.
  test("the generic 404 hint does not blame the active company outright", () => {
    const err = new CliError("Not found", 404, { code: null }, 5);
    const hint = hintForError(err, null) ?? "";
    expect(hint).not.toMatch(/likely does not exist in the ACTIVE company/i);
    expect(hint).toMatch(/if it IS tenant-scoped/i);
  });

  test("a command's own 404 remedy still wins for a plain resource-404", () => {
    const err = new CliError("Not found", 404, { code: null }, 5);
    const specErrors = [{ http: 404, exit: 5, meaning: "Not found", remedy: "no keikka with that id" }];
    expect(hintForError(err, specErrors)).toBe("no keikka with that id");
  });
});

// The matcher keys a spec row to an error by its DECLARED origin: `http` for
// server-originated failures, `origin: "client"` (matched on `exit`) for ones the
// CLI raised locally. A server row that forgets `http` is unreachable for a real
// HTTP failure — the trap behind feedback #280, where `ib reference detail get`'s
// single http-less exit-5 row never matched the catalog route's 404 and the caller
// got the generic tenancy hint instead. `CommandError` now makes that omission a
// compile error (feedback #289); these tests pin the runtime half.
describe("hintForError — spec rows match on their declared origin", () => {
  const clientRow = [
    { origin: "client" as const, exit: 5, meaning: "Unknown command", remedy: "`ib commands` for valid paths" },
  ];

  test("a client row matches a locally-raised exit-5 error (statusCode 0)", () => {
    const err = new CliError("unknown command: ib bogus", 0, null, 5);
    expect(hintForError(err, clientRow)).toBe("`ib commands` for valid paths");
  });

  test("a client row does NOT match a real HTTP 404 — generic hint instead", () => {
    const err = new CliError("no detail recorded", 404, { code: null }, 5);
    expect(hintForError(err, clientRow)).toMatch(/no such resource/i);
  });

  test("pairing it with an http:404 row makes the server case match too", () => {
    const paired = [
      ...clientRow,
      { http: 404, exit: 5, meaning: "No detail yet", remedy: "add it with `ib reference detail set`" },
    ];
    const clientSide = new CliError("unknown command: ib bogus", 0, null, 5);
    const server = new CliError("no detail recorded", 404, { code: null }, 5);
    expect(hintForError(clientSide, paired)).toBe("`ib commands` for valid paths");
    expect(hintForError(server, paired)).toBe("add it with `ib reference detail set`");
  });

  test("a row declaring NEITHER origin is dead on both paths (why the type forbids it)", () => {
    // Only reachable via a cast — kept as the executable record of the defect.
    const undeclared = [{ exit: 3, meaning: "Not a developer", remedy: "use a developer token" }] as never;
    expect(hintForError(new CliError("Forbidden", 403, null, 3), undeclared)).toMatch(/permission denied/i);
    expect(hintForError(new CliError("local gate", 0, null, 3), undeclared)).toBeNull();
  });
});

// The legal-save exit-4 spec remedy that used to mislead edit-mode errors.
const exit4Spec = [
  { origin: "client" as const, exit: 4, meaning: "no content", remedy: "pass --file OR --content, and --reason unless --dry-run" },
];

describe("hintForError — error-carried hint (failUsage)", () => {
  test("a client-side exit-4 error with no hint inherits the command's spec remedy", () => {
    const err = new CliError("--replace search text not found in the current field", 0, null, 4);
    expect(hintForError(err, exit4Spec)).toBe("pass --file OR --content, and --reason unless --dry-run");
  });

  test("a non-empty carried hint OVERRIDES the spec remedy", () => {
    const err = new CliError("--replace search text not found in the current field", 0, null, 4, "read the current field first");
    expect(hintForError(err, exit4Spec)).toBe("read the current field first");
  });

  test('an empty-string carried hint SUPPRESSES the spec remedy (message is the remedy)', () => {
    const err = new CliError("edit mode is mutually exclusive with --file/--content", 0, null, 4, "");
    expect(hintForError(err, exit4Spec)).toBeNull();
  });
});

// fb#305/#306 — client rows are keyed by exit code, so a command with two at the
// same exit used to serve whichever was listed first to every hintless guard.
describe("hintForError — client rows disambiguated by `match`", () => {
  const twoRows = [
    { origin: "client" as const, exit: 4, match: "--boom", meaning: "bad boom", remedy: "pass metres >= 0" },
    { origin: "client" as const, exit: 4, match: "--asiakas", meaning: "bad asiakas", remedy: "pass a positive asiakasId" },
  ];

  test("each row answers its OWN message, regardless of listing order", () => {
    expect(hintForError(new CliError("--boom must be a non-negative number", 0, null, 4), twoRows))
      .toBe("pass metres >= 0");
    expect(hintForError(new CliError("--asiakas must be a positive integer asiakasId", 0, null, 4), twoRows))
      .toBe("pass a positive asiakasId");
  });

  test("a message matching NO row yields no hint instead of the first row's remedy", () => {
    expect(hintForError(new CliError("value too long — --impact is 505 chars", 0, null, 4), twoRows))
      .toBeNull();
  });

  test("matching is case-insensitive", () => {
    expect(hintForError(new CliError("--BOOM must be a number", 0, null, 4), twoRows))
      .toBe("pass metres >= 0");
  });

  test("an array `match` fires on ANY of its alternatives", () => {
    const rows = [
      { origin: "client" as const, exit: 4, match: ["is required", "must be one of"], meaning: "validation", remedy: "check the flags" },
      { origin: "client" as const, exit: 4, match: "--from-json", meaning: "bad file", remedy: "check the path" },
    ];
    expect(hintForError(new CliError("description is required", 0, null, 4), rows)).toBe("check the flags");
    expect(hintForError(new CliError("--scope must be one of: cli, app", 0, null, 4), rows)).toBe("check the flags");
    expect(hintForError(new CliError("--from-json x.json is not valid JSON", 0, null, 4), rows)).toBe("check the path");
  });

  test("a lone row that declares `match` does NOT win by exit code alone", () => {
    const rows = [{ origin: "client" as const, exit: 4, match: "--boom", meaning: "bad boom", remedy: "pass metres >= 0" }];
    expect(hintForError(new CliError("something else entirely", 0, null, 4), rows)).toBeNull();
  });

  test("client rows never answer a SERVER error at the same exit (fb#289 guard holds)", () => {
    expect(hintForError(new CliError("Bad Request", 400, null, 4), twoRows)).toBeNull();
  });
});

describe("failUsage", () => {
  test("throws a CliError carrying exit 4 and the (default-empty) suppressing hint", () => {
    try {
      failUsage("--with requires --replace");
      throw new Error("failUsage did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      const err = e as CliError;
      expect(err.exitCode).toBe(4);
      expect(err.statusCode).toBe(0);
      expect(err.hint).toBe(""); // empty => suppresses the spec remedy
      // and an empty hint resolves to no envelope hint even against a matching spec row
      expect(hintForError(err, exit4Spec)).toBeNull();
    }
  });

  test("forwards a positive hint that overrides the spec remedy", () => {
    try {
      failUsage("--replace search text not found in the current field", "read the current field first");
      throw new Error("failUsage did not throw");
    } catch (e) {
      const err = e as CliError;
      expect(err.hint).toBe("read the current field first");
      expect(hintForError(err, exit4Spec)).toBe("read the current field first");
    }
  });
});

// feedback #311: an empty hint has to beat the `http` row too, not just the
// client-origin one. The global `--company` switch fails BEFORE the command
// reaches its own endpoint, so the leaf's HTTP 403 remedy is a false lead
// (`ib person search --company <id>` answered a switch 403 with "check
// auth.page.person.read"). Suppression is checked ahead of the httpRow match.
describe("hintForError — empty hint suppresses an HTTP row (feedback #311)", () => {
  const perm403 = [
    { http: 403, exit: 3, meaning: "Permission denied", remedy: "check auth.page.person.read" },
  ];

  test("a 403 carrying an empty hint yields no envelope hint", () => {
    const err = new CliError("Company switch failed: HTTP 403 …", 403, null, 3, "");
    expect(hintForError(err, perm403)).toBeNull();
  });

  test("a 403 WITHOUT a hint still gets the command's own remedy", () => {
    const err = new CliError("Permission denied", 403, null, 3);
    expect(hintForError(err, perm403)).toBe("check auth.page.person.read");
  });
});

// fb#485 — http rows used to match by STATUS alone, so a command with two causes
// behind one status served the first-listed remedy for both. Observed on `ib
// legal save`: a SQL truncation 400 ("Arvo on liian pitkä sarakkeeseen 'title'.")
// answered with "provide --type --doc-version --title and content" even though
// every field was provided.
describe("hintForError — http rows disambiguated by `match` (fb#485)", () => {
  const legalSave400s = [
    {
      http: 400, exit: 4, match: ["liian pitkä", "string or binary data"],
      meaning: "field too long", remedy: "shorten the field the message names",
    },
    { http: 400, exit: 4, meaning: "required fields missing", remedy: "provide --type --doc-version --title and content" },
  ];

  test("the matching row wins over the status catch-all", () => {
    const err = new CliError("400 Arvo on liian pitkä sarakkeeseen 'title'.", 400, null, 4);
    expect(hintForError(err, legalSave400s)).toBe("shorten the field the message names");
  });

  test("a message hitting no `match` falls back to the status catch-all", () => {
    const err = new CliError("400 Required fields missing", 400, null, 4);
    expect(hintForError(err, legalSave400s)).toBe("provide --type --doc-version --title and content");
  });

  test("matching is case-insensitive and fires on ANY array alternative", () => {
    const err = new CliError("400 String or Binary Data would be truncated", 400, null, 4);
    expect(hintForError(err, legalSave400s)).toBe("shorten the field the message names");
  });

  test("the catch-all is the first row with NO match, whatever the listing order", () => {
    const reordered = [legalSave400s[1], legalSave400s[0]];
    const err = new CliError("400 Arvo on liian pitkä sarakkeeseen 'title'.", 400, null, 4);
    expect(hintForError(err, reordered)).toBe("shorten the field the message names");
  });

  test("a status-only spec is byte-for-byte unaffected (the pre-fb#485 contract)", () => {
    const statusOnly = [
      { http: 400, exit: 4, meaning: "first", remedy: "first remedy" },
      { http: 400, exit: 4, meaning: "second", remedy: "second remedy" },
    ];
    const err = new CliError("400 anything at all", 400, null, 4);
    expect(hintForError(err, statusOnly)).toBe("first remedy");
  });

  test("all rows carry `match` and none hit → the generic per-status hint, not a wrong remedy", () => {
    const allMatched = [
      { http: 404, exit: 5, match: "no such keikka", meaning: "a", remedy: "a remedy" },
      { http: 404, exit: 5, match: "no such vehicle", meaning: "b", remedy: "b remedy" },
    ];
    const err = new CliError("404 no such worksite", 404, { code: null }, 5);
    expect(hintForError(err, allMatched)).toMatch(/no such resource/i);
  });

  test("`match` on http rows does NOT reintroduce exit-code fallback (fb#289 guard holds)", () => {
    // A client-origin error at the same exit code must still find no http row.
    const err = new CliError("liian pitkä", 0, null, 4);
    expect(hintForError(err, legalSave400s)).toBeNull();
  });
});

// fb#579: the friction log must be able to tell "the command anticipated this
// 404" from "the CLI produced a fallback". Same resolution as hintForError —
// it is now literally the same function — plus where the hint came from.
describe("hintDetailForError — hint provenance", () => {
  const notFoundSpec = [
    { http: 404, exit: 5, meaning: "Grade not found", remedy: "list the catalogue with `ib betoni laatu list`" },
  ];

  test("a matching spec ERRORS row is `spec` (the command documented this failure)", () => {
    const err = new CliError("Grade not found in this supplier's catalogue: 2", 404, null, 5);
    const d = hintDetailForError(err, notFoundSpec);
    expect(d.source).toBe("spec");
    expect(d.hint).toBe("list the catalogue with `ib betoni laatu list`");
  });

  test("a remedy attached at the throw site is `error`", () => {
    const err = new CliError("--replace text not found", 0, null, 4, "read the current field first");
    expect(hintDetailForError(err, null).source).toBe("error");
  });

  test("an UNDEPLOYED route is `route-not-found`, never `spec` — even with a 404 row present", () => {
    const err = new CliError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }, 5);
    expect(hintDetailForError(err, notFoundSpec).source).toBe("route-not-found");
  });

  test("an unclassified 404 falls back to `generic`", () => {
    const err = new CliError("404 no such worksite", 404, { code: null }, 5);
    const d = hintDetailForError(err, null);
    expect(d.source).toBe("generic");
    expect(d.hint).toMatch(/no such resource/i);
  });

  test("no hint at all -> both null", () => {
    expect(hintDetailForError(new CliError("local gate", 0, null, 3), null)).toEqual({
      hint: null,
      source: null,
    });
  });

  // An empty err.hint deliberately SUPPRESSES the spec remedy (the message is
  // already the whole remedy). That is a null hint, so there is nothing to
  // attribute — and it must not read as a curated witness.
  //
  // Semantically debatable at exit 5: an empty hint is arguably the STRONGEST
  // "the command anticipated this and the message IS the remedy" signal, so such
  // a 404 would be captured as friction despite being answered. Unreachable
  // today (every failWith(…, 5) site passes a real hint or none, and failUsage
  // is exit-4 only). If a `failWith(msg, 5, "")` ever appears, revisit this.
  test("an empty error-carried hint suppresses the hint and reports no source", () => {
    const err = new CliError("self-explanatory", 400, null, 4, "");
    expect(hintDetailForError(err, [{ http: 400, exit: 4, meaning: "m", remedy: "r" }])).toEqual({
      hint: null,
      source: null,
    });
  });

  test("hintForError stays exactly hintDetailForError's hint (no drift)", () => {
    const cases: CliError[] = [
      new CliError("Grade not found", 404, null, 5),
      new CliError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }, 5),
      new CliError("boom", 500, null, 6),
      new CliError("local gate", 0, null, 3),
    ];
    for (const err of cases) {
      expect(hintForError(err, notFoundSpec)).toBe(hintDetailForError(err, notFoundSpec).hint);
    }
  });
});
