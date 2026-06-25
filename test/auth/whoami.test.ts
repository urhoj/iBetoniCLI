import { describe, test, expect } from "vitest";
import { renderWhoami } from "../../src/auth/whoami.js";
import type { DecodedClaims } from "../../src/auth/jwt.js";

const claims = (over: Partial<DecodedClaims> = {}): DecodedClaims => ({
  personId: 42,
  ownerAsiakasId: 8,
  ownerAsiakasName: "Example Oy",
  email: "user@example.fi",
  exp: 4102444800, // 2100-01-01, far future
  isSystemAdmin: false,
  isDeveloper: false,
  isActiveCompanyAdmin: false,
  companies: [
    { asiakasId: 8, roles: ["asiakasAdmin"] },
    { asiakasId: 26, roles: [] },
  ],
  ...over,
});

const input = (over: Partial<Parameters<typeof renderWhoami>[0]> = {}) => ({
  claims: claims(),
  endpoint: "https://api.ibetoni.fi",
  source: "file" as const,
  readOnly: false,
  tier: "standard" as const,
  nowMs: Date.parse("2026-01-01T00:00:00Z"),
  ...over,
});

describe("renderWhoami", () => {
  test("surfaces identity, tier, companies, expiry, source, readOnly", () => {
    const out = renderWhoami(input({ tier: "developer" }));
    expect(out.personId).toBe(42);
    expect(out.email).toBe("user@example.fi");
    expect(out.activeCompany).toEqual({ asiakasId: 8, name: "Example Oy" });
    expect(out.tier).toBe("developer");
    expect(out.companies).toEqual([
      { asiakasId: 8, roles: ["asiakasAdmin"] },
      { asiakasId: 26, roles: [] },
    ]);
    expect(out.endpoint).toBe("https://api.ibetoni.fi");
    expect(out.source).toBe("file");
    expect(out.readOnly).toBe(false);
    expect(out.tokenExpired).toBe(false);
    expect(out.tokenExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("flags the BetoniJerry umbrella tenant (1349)", () => {
    const out = renderWhoami(input({ claims: claims({ ownerAsiakasId: 1349, ownerAsiakasName: "BetoniJerry" }) }));
    expect(out.activeCompany.betoniJerryUmbrella).toBe(true);
  });

  test("does NOT flag a normal tenant", () => {
    expect(renderWhoami(input()).activeCompany.betoniJerryUmbrella).toBeUndefined();
  });

  test("reports an expired token", () => {
    const out = renderWhoami(input({ claims: claims({ exp: 1577836800 }) /* 2020 */ }));
    expect(out.tokenExpired).toBe(true);
  });

  test("source 'env' reflects an IB_TOKEN session", () => {
    expect(renderWhoami(input({ source: "env" })).source).toBe("env");
  });

  test("readOnly reflects the write-lock", () => {
    expect(renderWhoami(input({ readOnly: true })).readOnly).toBe(true);
  });

  test("omits impersonating for a normal session", () => {
    expect(renderWhoami(input()).impersonating).toBeUndefined();
  });

  test("includes impersonating from the creds profile", () => {
    const out = renderWhoami(input({ impersonation: { actorPersonId: 10, sessionId: "sid" } }));
    expect(out.impersonating).toEqual({ actorPersonId: 10, sessionId: "sid" });
  });

  test("falls back to JWT imp claims when no profile impersonation (IB_TOKEN)", () => {
    const out = renderWhoami(input({ source: "env", claims: claims({ imp: 10, imp_sid: "sid" }) }));
    expect(out.impersonating).toEqual({ actorPersonId: 10, sessionId: "sid" });
  });
});
