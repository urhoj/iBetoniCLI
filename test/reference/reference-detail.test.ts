import { describe, test, expect } from "vitest";
import { runReferenceDetail } from "../../src/reference/detail.js";
import { CliError } from "../../src/api/errors.js";

describe("runReferenceDetail", () => {
  test("returns { command, detail, hint } for a command that has detail", () => {
    const out = runReferenceDetail(["keikka", "latest"]);
    expect(out.command).toBe("ib keikka latest");
    expect(out.detail).toMatch(/Keikka = yksi betonin/);
    expect(out.hint).toContain('--command "reference detail keikka latest"');
  });

  test("exit 5 for a known command with no detail yet", () => {
    try {
      runReferenceDetail(["keikka", "get"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(5);
    }
  });

  test("exit 5 for an unknown command", () => {
    try {
      runReferenceDetail(["nope", "nope"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CliError).exitCode).toBe(5);
    }
  });

  test("hides developer-tier commands from a standard caller (fail-closed)", () => {
    // developer tier: found-but-no-detail branch
    expect(() => runReferenceDetail(["schema", "table"], "developer")).toThrowError(/no detail/);
    // standard tier: filtered out by visibleSpecs -> treated as unknown
    expect(() => runReferenceDetail(["schema", "table"], "standard")).toThrowError(/unknown command/);
  });
});
