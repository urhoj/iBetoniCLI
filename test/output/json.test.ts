import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeJson,
  writeError,
  exitWithError,
  failWith,
  errorMessage,
  setActiveCommandErrors,
  setListColumns,
  setOutputMode,
  setProjectionColumns,
} from "../../src/output/json";
import { CliError } from "../../src/api/errors";

describe("JSON output", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  test("writeJson serializes object to stdout with newline", () => {
    writeJson({ a: 1, b: [2, 3] });
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ a: 1, b: [2, 3] }) + "\n"
    );
  });

  test("writeError emits backend-shape error to stderr", () => {
    const err = new CliError(
      "denied",
      403,
      { error: "denied", code: "FORBIDDEN" },
      3
    );
    writeError(err);
    expect(stderrSpy).toHaveBeenCalled();
    const line = String(stderrSpy.mock.calls[0][0]);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      success: false,
      error: "denied",
      code: "FORBIDDEN",
      statusCode: 403,
      hint: expect.stringContaining("PERMISSIONS"),
    });
  });

  test("writeError on a plain 404 hints at resource-not-found + the ROUTE_NOT_FOUND discriminator", () => {
    writeError(new CliError("HTTP 404", 404, null, 5));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    expect(parsed.hint).toMatch(/ROUTE_NOT_FOUND/);
    expect(parsed.hint).toMatch(/ib version/);
  });

  test("writeError on a 404 with code:ROUTE_NOT_FOUND hints the route is not deployed", () => {
    writeError(new CliError("Route not found", 404, { code: "ROUTE_NOT_FOUND" }, 5));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    expect(parsed.code).toBe("ROUTE_NOT_FOUND");
    expect(parsed.hint).toMatch(/not deployed/i);
  });

  test("writeError omits hint when there is none (read-only refusal)", () => {
    writeError(new CliError("Refused: read-only", 0, null, 3));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    expect(parsed).not.toHaveProperty("hint");
  });

  test("writeError on a network error (exit 7) hints at connectivity", () => {
    writeError(new CliError("Network error: ECONNREFUSED", 0, null, 7));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    expect(parsed.hint).toMatch(/connectivity|network/i);
  });

  // exitWithError sets process.exitCode (natural drain) instead of calling
  // process.exit() — forced exit after a fetch crashes Node on Windows.
  test("exitWithError writes the error then sets the CliError's mapped exit code", () => {
    const prev = process.exitCode;
    exitWithError(new CliError("missing", 404, null, 5));
    expect(stderrSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(5);
    process.exitCode = prev;
  });

  test("exitWithError sets exitCode 1 for a non-CliError", () => {
    const prev = process.exitCode;
    exitWithError(new Error("plain"));
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
  });

  // failWith replaces every `writeError(...); process.exit(N)` guard pair —
  // it must THROW a CliError carrying the code (never call process.exit).
  test("failWith throws a CliError with the given message and exit code", () => {
    let err: unknown;
    try {
      failWith("Missing required flag: --reason", 4);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(4);
    expect((err as CliError).message).toBe("Missing required flag: --reason");
  });

  test("errorMessage extracts Error messages and stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain string")).toBe("plain string");
  });

  // Spec-remedy echo (#25): when the running command's spec ERRORS rows are
  // registered, the row matching the error's HTTP status (or exit code for
  // client-side statusCode-0 errors) supplies the hint; otherwise generic.
  describe("hint prefers the active command's spec remedy", () => {
    afterEach(() => setActiveCommandErrors(null));

    test("HTTP-status match wins over the generic hint", () => {
      setActiveCommandErrors([
        { http: 403, exit: 3, meaning: "Not a provider", remedy: "switch to a provider company" },
      ]);
      writeError(new CliError("denied", 403, null, 3));
      const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
      expect(parsed.hint).toBe("switch to a provider company");
    });

    test("statusCode-0 errors match client-origin spec rows by exit code", () => {
      setActiveCommandErrors([
        { origin: "client", exit: 4, meaning: "Missing --reason", remedy: "supply --reason" },
      ]);
      writeError(new CliError("Missing required flag: --reason", 0, null, 4));
      const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
      expect(parsed.hint).toBe("supply --reason");
    });

    test("no matching spec row falls back to the generic per-status hint", () => {
      setActiveCommandErrors([
        { http: 403, exit: 3, meaning: "x", remedy: "y" },
      ]);
      writeError(new CliError("HTTP 404", 404, null, 5));
      const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
      expect(parsed.hint).toMatch(/ROUTE_NOT_FOUND/);
    });
  });

  // fb#451: the global --columns is a REAL output projection applied at the
  // writeJson chokepoint — not a pretty-table-only pick that silently no-ops
  // in JSON mode. Silence is the bug: it either projects or fails loudly.
  describe("--columns projection (fb#451)", () => {
    afterEach(() => {
      setProjectionColumns(null);
      setListColumns(null);
      setOutputMode("json");
    });

    test("projects ListEnvelope items, keeping envelope metadata", () => {
      setProjectionColumns(["a"]);
      writeJson({ items: [{ a: 1, b: 2 }, { a: 3, b: 4 }], nextCursor: null, count: 2 });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({
        items: [{ a: 1 }, { a: 3 }],
        nextCursor: null,
        count: 2,
      });
    });

    test("projects a single record's top-level keys", () => {
      setProjectionColumns(["feedbackId", "status"]);
      writeJson({ feedbackId: 451, status: "open", description: "long prose" });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({
        feedbackId: 451,
        status: "open",
      });
    });

    // fb#596: `ib dev schema table X --columns name` matches the record's OWN
    // `name` (the TABLE name), so the no-match exit-4 guard cannot fire, and the
    // 27-row `columns[]` the caller actually meant is dropped in silence —
    // {name:"X"} reads as a successful "this table has no columns".
    test("a record whose payload is a nested list still projects, but warns", () => {
      setProjectionColumns(["name"]);
      writeJson({
        name: "sijainti",
        columns: [{ name: "sijaintiId" }, { name: "asiakasId" }],
        indexes: [{ name: "PK_sijainti" }],
      });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({
        name: "sijainti",
      });
      const warn = String(stderrSpy.mock.calls.at(-1)![0]);
      expect(warn).toContain("columns (2 rows)");
      expect(warn).toContain("indexes (1 row)");
      expect(warn).toContain("TOP-LEVEL");
    });

    // NB the spies are re-attached, never restored, so calls ACCUMULATE across
    // tests in this file — `not.toHaveBeenCalled()` would pick up an earlier
    // test's warning. Compare the count before/after, as the stdout cases do.
    test("a record with no nested list projects silently", () => {
      setProjectionColumns(["feedbackId"]);
      const before = stderrSpy.mock.calls.length;
      writeJson({ feedbackId: 596, status: "open" });
      expect(stderrSpy.mock.calls.length).toBe(before);
    });

    // Guards the array-OF-OBJECTS condition: dropping a scalar array is
    // unremarkable, and warning on it would bury the signal above.
    test("a dropped scalar array does not warn", () => {
      setProjectionColumns(["term"]);
      const before = stderrSpy.mock.calls.length;
      writeJson({ term: "puomi", synonyms: ["puomisto", "masto"] });
      expect(stderrSpy.mock.calls.length).toBe(before);
    });

    // The nested-list warning is record-only — for a list the ROW is the
    // payload, so firing once per item would be noise.
    test("list rows with nested lists do not warn", () => {
      setProjectionColumns(["a"]);
      const before = stderrSpy.mock.calls.length;
      writeJson({
        items: [{ a: 1, kids: [{ b: 2 }] }, { a: 3, kids: [{ b: 4 }] }],
        nextCursor: null,
        count: 2,
      });
      expect(stderrSpy.mock.calls.length).toBe(before);
    });

    test("partially unknown columns project the rest and warn on stderr", () => {
      setProjectionColumns(["a", "nope"]);
      writeJson({ a: 1, b: 2 });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({ a: 1 });
      expect(String(stderrSpy.mock.calls.at(-1)![0])).toContain("nope");
    });

    // fb#858: a name the did-you-mean cannot reach (nothing contains "title")
    // left the caller guessing blind on the next attempt — the note must
    // enumerate the accepted set itself.
    test("the ignore warning enumerates the available columns (fb#858)", () => {
      setProjectionColumns(["a", "title"]);
      writeJson({ a: 1, b: 2 });
      expect(String(stderrSpy.mock.calls.at(-1)![0])).toContain("available: a, b");
    });

    test("no matching column exits 4 listing what IS available", () => {
      setProjectionColumns(["nope"]);
      const callsBefore = stdoutSpy.mock.calls.length;
      let err: unknown;
      try {
        writeJson({ a: 1, b: 2 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(4);
      expect((err as CliError).message).toContain("a, b");
      expect(stdoutSpy.mock.calls.length).toBe(callsBefore);
    });

    // fb#671. The real miss: `--columns changelogId,version` on a row whose
    // field is `versionTag`. Warned, exited 0, and returned rows without it —
    // a stdout-only pipeline reads that as "this entry has no version".
    test("a near-miss column is named in the warning (fb#671)", () => {
      setProjectionColumns(["changelogId", "version"]);
      writeJson({ changelogId: 1484, versionTag: "betonicli", title: "x" });
      const warn = String(stderrSpy.mock.calls.at(-1)![0]);
      expect(warn).toContain("version");
      expect(warn).toContain("did you mean `versionTag`?");
    });

    // The suggestion must not fire on a column that resembles nothing —
    // an invented-looking hint costs more than no hint.
    test("a column resembling nothing gets no suggestion", () => {
      setProjectionColumns(["a", "zzzzzzzz"]);
      writeJson({ a: 1, b: 2 });
      const warn = String(stderrSpy.mock.calls.at(-1)![0]);
      expect(warn).toContain("zzzzzzzz");
      expect(warn).not.toContain("did you mean");
    });

    // The exit-4 twin: same typo class, harder failure, so it gets the same hint.
    test("the no-match exit-4 message also suggests (fb#671)", () => {
      setProjectionColumns(["version"]);
      let err: unknown;
      try {
        writeJson({ changelogId: 1484, versionTag: "betonicli" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain("did you mean `versionTag`?");
    });

    test("unprojectable scalar output exits 4 instead of a silent no-op", () => {
      setProjectionColumns(["a"]);
      const callsBefore = stdoutSpy.mock.calls.length;
      expect(() => writeJson("just a string")).toThrowError(CliError);
      expect(stdoutSpy.mock.calls.length).toBe(callsBefore);
    });

    test("an empty list passes through unchanged", () => {
      setProjectionColumns(["a"]);
      writeJson({ items: [], nextCursor: null, count: 0 });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({
        items: [],
        nextCursor: null,
        count: 0,
      });
    });

    test("spec prettyColumns alone (setListColumns) must NOT project JSON", () => {
      setListColumns(["a"]);
      writeJson({ a: 1, b: 2 });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({ a: 1, b: 2 });
    });

    test("--pretty single record renders only the projected fields", () => {
      setOutputMode("pretty");
      setProjectionColumns(["feedbackId"]);
      writeJson({ feedbackId: 451, description: "long prose" });
      const out = String(stdoutSpy.mock.calls.at(-1)![0]);
      expect(out).toContain("feedbackId");
      expect(out).not.toContain("description");
    });
  });
});
