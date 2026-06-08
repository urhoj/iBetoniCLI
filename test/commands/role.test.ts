import { describe, test, expect } from "vitest";
import { explainRole } from "../../src/roles.js";

describe("explainRole", () => {
  test("asiakasAdmin → typeId 2, display name, admin tier, not deprecated", () => {
    const r = explainRole("asiakasAdmin");
    expect(r).toMatchObject({ role: "asiakasAdmin", typeId: 2, displayName: "Asiakas Admin", deprecated: false });
    expect(r.tiers).toContain("anyAdmin");
  });

  test("lomaseurannassa → typeId 15, not an admin tier", () => {
    const r = explainRole("lomaseurannassa");
    expect(r.typeId).toBe(15);
    expect(r.tiers).not.toContain("anyAdmin");
  });

  test("pumppuHandler → deprecated (legacy typeId 20)", () => {
    const r = explainRole("pumppuHandler");
    expect(r.typeId).toBe(20);
    expect(r.deprecated).toBe(true);
  });

  test("throws a descriptive error on an unknown role name", () => {
    expect(() => explainRole("notArole")).toThrow(/unknown role/i);
  });
});
