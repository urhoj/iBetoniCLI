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

    test("partially unknown columns project the rest and warn on stderr", () => {
      setProjectionColumns(["a", "nope"]);
      writeJson({ a: 1, b: 2 });
      expect(JSON.parse(String(stdoutSpy.mock.calls.at(-1)![0]))).toEqual({ a: 1 });
      expect(String(stderrSpy.mock.calls.at(-1)![0])).toContain("nope");
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
