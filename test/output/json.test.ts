import { describe, test, expect, vi, beforeEach } from "vitest";
import { writeJson, writeError } from "../../src/output/json";
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
    });
  });
});
