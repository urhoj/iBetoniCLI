import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeJson,
  writeError,
  exitWithError,
  failWith,
  errorMessage,
  setActiveCommandErrors,
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

    test("statusCode-0 errors match spec rows by exit code", () => {
      setActiveCommandErrors([
        { exit: 4, meaning: "Missing --reason", remedy: "supply --reason" },
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
});
