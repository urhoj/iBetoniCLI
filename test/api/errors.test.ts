import { describe, test, expect } from "vitest";
import { CliError, exitCodeForError, hintForError } from "../../src/api/errors.js";

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
    expect(hint).toMatch(/does not exist in the ACTIVE company/i);
  });

  test("a command's own 404 remedy still wins for a plain resource-404", () => {
    const err = new CliError("Not found", 404, { code: null }, 5);
    const specErrors = [{ http: 404, exit: 5, meaning: "Not found", remedy: "no keikka with that id" }];
    expect(hintForError(err, specErrors)).toBe("no keikka with that id");
  });
});
