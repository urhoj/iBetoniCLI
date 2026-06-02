import { describe, test, expect } from "vitest";
import { CliError, exitCodeForError } from "../../src/api/errors.js";

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
