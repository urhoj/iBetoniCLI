import { describe, test, expect, beforeEach } from "vitest";
import {
  resolveCallerTier,
  isHiddenAtTier,
  visibleSpecs,
  getCallerTier,
  setCallerTier,
} from "../src/tier.js";

/** Build a minimal unsigned JWT (header.body.sig) with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("resolveCallerTier", () => {
  test("developer flag → developer", () => {
    expect(resolveCallerTier(jwt({ globalRoles: { isDeveloper: true } }))).toBe(
      "developer"
    );
  });
  test("systemAdmin flag → developer", () => {
    expect(
      resolveCallerTier(jwt({ globalRoles: { isSystemAdmin: true } }))
    ).toBe("developer");
  });
  test("no global roles → standard", () => {
    expect(resolveCallerTier(jwt({ personId: 1 }))).toBe("standard");
  });
  test("no token → standard (fail-closed)", () => {
    expect(resolveCallerTier(null)).toBe("standard");
    expect(resolveCallerTier(undefined)).toBe("standard");
    expect(resolveCallerTier("")).toBe("standard");
  });
  test("malformed token → standard (fail-closed)", () => {
    expect(resolveCallerTier("not-a-jwt")).toBe("standard");
  });
  test("active-company admin (no global role) → admin", () => {
    const token = jwt({
      ownerAsiakasId: 8,
      asiakasesWithTypes: [{ asiakasId: 8, roles: ["asiakasAdmin"] }],
    });
    expect(resolveCallerTier(token)).toBe("admin");
  });
  test("developer outranks admin", () => {
    const token = jwt({
      globalRoles: { isDeveloper: true },
      ownerAsiakasId: 8,
      asiakasesWithTypes: [{ asiakasId: 8, roles: ["asiakasAdmin"] }],
    });
    expect(resolveCallerTier(token)).toBe("developer");
  });
});

describe("isHiddenAtTier / visibleSpecs", () => {
  const specs = [
    { command: "ib a", tier: "developer" as const },
    { command: "ib b" },
  ];
  test("developer leaf hidden from standard", () => {
    expect(isHiddenAtTier(specs[0], "standard")).toBe(true);
    expect(isHiddenAtTier(specs[1], "standard")).toBe(false);
  });
  test("nothing hidden from developer", () => {
    expect(isHiddenAtTier(specs[0], "developer")).toBe(false);
    expect(visibleSpecs(specs, "developer")).toHaveLength(2);
  });
  test("visibleSpecs drops developer leaves for standard", () => {
    expect(visibleSpecs(specs, "standard").map((s) => s.command)).toEqual([
      "ib b",
    ]);
  });
});

describe("ambient tier default (module init)", () => {
  // No beforeEach — verifies the raw module-initialization value before any set.
  test("initial value is developer", () => {
    expect(getCallerTier()).toBe("developer");
  });
});

describe("ambient tier holder", () => {
  beforeEach(() => setCallerTier("developer"));
  test("set/get round-trips", () => {
    setCallerTier("standard");
    expect(getCallerTier()).toBe("standard");
  });
});

describe("ladder ranking", () => {
  const specs = [
    { command: "ib dev", tier: "developer" as const },
    { command: "ib adm", tier: "admin" as const },
    { command: "ib open" },
  ];
  test("standard sees only untagged", () => {
    expect(visibleSpecs(specs, "standard").map((s) => s.command)).toEqual(["ib open"]);
  });
  test("admin sees admin + untagged, not developer", () => {
    expect(visibleSpecs(specs, "admin").map((s) => s.command)).toEqual(["ib adm", "ib open"]);
  });
  test("developer sees everything", () => {
    expect(visibleSpecs(specs, "developer")).toHaveLength(3);
  });
  test("admin leaf hidden from standard, visible to admin", () => {
    expect(isHiddenAtTier(specs[1], "standard")).toBe(true);
    expect(isHiddenAtTier(specs[1], "admin")).toBe(false);
  });
});
