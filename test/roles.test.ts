import { describe, test, expect } from "vitest";
import { resolveRoleTypeId, roleNameForTypeId } from "../src/roles.js";
import { CliError } from "../src/api/errors.js";

describe("resolveRoleTypeId", () => {
  test("maps a known role name to its typeId", () => {
    expect(resolveRoleTypeId("keikkaHandler")).toBe(11);
    expect(resolveRoleTypeId("hrAdmin")).toBe(24);
  });

  test("returns 0 for an undefined name (no-filter sentinel)", () => {
    expect(resolveRoleTypeId(undefined)).toBe(0);
    expect(resolveRoleTypeId("")).toBe(0);
  });

  test("throws on an unknown role, listing valid names", () => {
    expect(() => resolveRoleTypeId("notARole")).toThrow(/unknown role/i);
    expect(() => resolveRoleTypeId("notARole")).toThrow(/keikkaHandler/);
  });

  // The guard is local — no request is made — so it must report itself as
  // client-origin (`statusCode: 0`). It used to fabricate 400, which both lied
  // in the envelope and hid `ib person list`'s own client ERRORS remedy from
  // `hintForError` (it consults `matchClientRow` only at statusCode 0).
  test("unknown role is a client-origin CliError mapped to validation exit 4", () => {
    let caught: unknown;
    try {
      resolveRoleTypeId("notARole");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).statusCode).toBe(0);
    expect((caught as CliError).exitCode).toBe(4);
  });
});

describe("roleNameForTypeId", () => {
  test("maps a known typeId to its name", () => {
    expect(roleNameForTypeId(11)).toBe("keikkaHandler");
    expect(roleNameForTypeId(8)).toBe("pumppari");
  });

  test("returns null for an unknown typeId", () => {
    expect(roleNameForTypeId(9999)).toBeNull();
  });
});
