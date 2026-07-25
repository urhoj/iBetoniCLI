import { describe, test, expect } from "vitest";
import { CliError, exitCodeForError, hintForError } from "../../src/api/errors.js";
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

// The matcher keys a spec row to an error by `http` (server-originated) or, for
// client-side errors only (statusCode 0), by `exit`. A row written WITHOUT `http`
// is therefore unreachable for a real HTTP failure — the trap behind feedback #280,
// where `ib reference detail get`'s single http-less exit-5 row never matched the
// catalog route's 404 and the caller got the generic tenancy hint instead.
describe("hintForError — http-less spec rows only match client-side errors", () => {
  const httpLess = [{ exit: 5, meaning: "Unknown command", remedy: "`ib commands` for valid paths" }];

  test("an http-less exit-5 row matches a client-side exit-5 error (statusCode 0)", () => {
    const err = new CliError("unknown command: ib bogus", 0, null, 5);
    expect(hintForError(err, httpLess)).toBe("`ib commands` for valid paths");
  });

  test("an http-less exit-5 row does NOT match a real HTTP 404 — generic hint instead", () => {
    const err = new CliError("no detail recorded", 404, { code: null }, 5);
    expect(hintForError(err, httpLess)).toMatch(/no such resource/i);
  });

  test("pairing it with an http:404 row makes the server case match too", () => {
    const paired = [
      ...httpLess,
      { http: 404, exit: 5, meaning: "No detail yet", remedy: "add it with `ib reference detail set`" },
    ];
    const clientSide = new CliError("unknown command: ib bogus", 0, null, 5);
    const server = new CliError("no detail recorded", 404, { code: null }, 5);
    expect(hintForError(clientSide, paired)).toBe("`ib commands` for valid paths");
    expect(hintForError(server, paired)).toBe("add it with `ib reference detail set`");
  });
});

// The legal-save exit-4 spec remedy that used to mislead edit-mode errors.
const exit4Spec = [
  { exit: 4, meaning: "no content", remedy: "pass --file OR --content, and --reason unless --dry-run" },
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
