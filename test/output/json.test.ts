import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  writeJson,
  writeError,
  exitWithError,
  failWith,
  errorMessage,
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

  test("writeError on a 404 hints at the deploy-gate ambiguity", () => {
    writeError(new CliError("HTTP 404", 404, null, 5));
    const parsed = JSON.parse(String(stderrSpy.mock.calls.at(-1)![0]));
    expect(parsed.hint).toMatch(/deploy-gated/);
    expect(parsed.hint).toMatch(/ib version/);
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
});
