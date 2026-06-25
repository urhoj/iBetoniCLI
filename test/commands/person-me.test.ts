import { describe, test, expect, vi, beforeEach } from "vitest";
import { runPersonMe, runPersonCompanies } from "../../src/commands/person/index.js";
import type { ApiClient } from "../../src/api/client.js";

const PAYLOAD = Buffer.from(
  JSON.stringify({ personId: 6233, ownerAsiakasId: 1349, email: "sys@x.fi" })
).toString("base64url");
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.sig`;

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(() => FAKE_JWT),
} as unknown as ApiClient;

describe("runPersonMe", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue(FAKE_JWT);
  });

  test("decodes the JWT and composes profile + roles + companies", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ personId: 6233, name: "System Jerry", email: "sys@x.fi", phone: "+358", roles: [11, 8] })
      .mockResolvedValueOnce({
        companies: [
          { asiakasId: 1349, asiakasNimi: "BetoniJerry" },
          { asiakasId: 26, asiakasNimi: "Kalle Urho Oy" },
        ],
        currentCompanyId: 1349,
      });
    const result = await runPersonMe(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/get/6233");
    expect(mockClient.get).toHaveBeenCalledWith("/api/company-selection/available");
    expect(result.personId).toBe(6233);
    expect(result.activeCompany).toEqual({ asiakasId: 1349, name: "BetoniJerry" });
    expect(result.roles).toEqual([
      { roleTypeId: 11, role: "keikkaHandler" },
      { roleTypeId: 8, role: "pumppari" },
    ]);
    expect(result.companies).toEqual([
      { asiakasId: 1349, name: "BetoniJerry", current: true },
      { asiakasId: 26, name: "Kalle Urho Oy", current: false },
    ]);
    // No globalRoles / admin roles on the token → standard tier; no imp claim.
    expect(result.tier).toBe("standard");
    expect(result.impersonating).toBeUndefined();
  });

  test("surfaces tier (from globalRoles) and an active impersonation session", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        personId: 6233,
        ownerAsiakasId: 1349,
        email: "sys@x.fi",
        globalRoles: { isDeveloper: true },
        imp: 999,
        imp_sid: "sess-abc",
      })
    ).toString("base64url");
    (mockClient.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue(
      `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
    );
    (mockClient.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ personId: 6233, name: "System Jerry", email: "sys@x.fi", phone: "+358", roles: [] })
      .mockResolvedValueOnce({ companies: [{ asiakasId: 1349, asiakasNimi: "BetoniJerry" }], currentCompanyId: 1349 });
    const result = await runPersonMe(mockClient);
    expect(result.tier).toBe("developer");
    expect(result.impersonating).toEqual({ actorPersonId: 999, sessionId: "sess-abc" });
  });
});

describe("runPersonCompanies", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue(FAKE_JWT);
  });

  test("uses the explicit personId when given", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasId: 26, asiakasNimi: "Kalle Urho Oy" },
    ]);
    const result = await runPersonCompanies(mockClient, 5351);
    expect(mockClient.get).toHaveBeenCalledWith("/api/person/getUserAsiakasList/5351");
    expect(result.items).toEqual([{ asiakasId: 26, name: "Kalle Urho Oy" }]);
    expect(result.count).toBe(1);
  });

  test("defaults to the caller's personId from the JWT", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runPersonCompanies(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/person/getUserAsiakasList/6233");
  });
});
