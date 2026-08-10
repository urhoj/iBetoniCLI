import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPersonMe,
  runPersonCompanies,
  runPersonCompaniesAsToken,
} from "../../src/commands/person/index.js";
import { CliError } from "../../src/api/errors.js";

const PAYLOAD = Buffer.from(
  JSON.stringify({ personId: 6233, ownerAsiakasId: 1349, email: "sys@x.fi" })
).toString("base64url");
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${PAYLOAD}.sig`;

/** A token carrying the `asiakasesWithTypes` claim `--as-token` reports. */
const CLAIM_PAYLOAD = Buffer.from(
  JSON.stringify({
    personId: 6233,
    iat: 1754375517,
    asiakasesWithTypes: [
      { asiakasId: 1349, roles: ["asiakasAdmin"], isPumppuToimittaja: true },
      { asiakasId: 26, roles: [] },
    ],
  })
).toString("base64url");
const CLAIM_JWT = `eyJhbGciOiJIUzI1NiJ9.${CLAIM_PAYLOAD}.sig`;

const mockClient = mockApiClient({ getCurrentToken: vi.fn(() => FAKE_JWT) });

beforeEach(() => {
  mockClient.get.mockReset();
  mockClient.getCurrentToken.mockReturnValue(FAKE_JWT);
});

/** Capture the error a synchronous call throws; fail loudly if it does not throw. */
function captured(fn: () => unknown): CliError {
  try {
    fn();
  } catch (e) {
    return e as CliError;
  }
  throw new Error("expected the call to throw, but it returned");
}

describe("runPersonMe", () => {
  test("decodes the JWT and composes profile + roles + companies", async () => {
    mockClient.get
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
    mockClient.getCurrentToken.mockReturnValue(
      `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`
    );
    mockClient.get
      .mockResolvedValueOnce({ personId: 6233, name: "System Jerry", email: "sys@x.fi", phone: "+358", roles: [] })
      .mockResolvedValueOnce({ companies: [{ asiakasId: 1349, asiakasNimi: "BetoniJerry" }], currentCompanyId: 1349 });
    const result = await runPersonMe(mockClient);
    expect(result.tier).toBe("developer");
    expect(result.impersonating).toEqual({ actorPersonId: 999, sessionId: "sess-abc" });
  });
});

/** A row as the authoritative backend route returns it. */
const BACKEND_ROW = {
  asiakasId: 26,
  name: "Kalle Urho Oy",
  roles: ["asiakasAdmin"],
  isTyomaaAsiakas: false,
  isPumppuToimittaja: true,
  isBetoniToimittaja: false,
  isLattiaToimittaja: false,
  activeMembership: true,
};

/** The fb#395 case: authorized (so present) but holding no live role there. */
const ROLELESS_ROW = {
  ...BACKEND_ROW,
  asiakasId: 908,
  name: "betoni.online",
  roles: [],
  isPumppuToimittaja: false,
  activeMembership: false,
};

describe("runPersonCompanies", () => {
  test("returns the authorization-aligned route's rows verbatim, incl. an authorized-but-roleless company", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [BACKEND_ROW, ROLELESS_ROW],
      nextCursor: null,
      count: 2,
      personId: 5351,
      source: "asiakas_listForPerson",
    });
    const result = await runPersonCompanies(mockClient, 5351);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/5351/companies");
    expect(result.source).toBe("asiakas_listForPerson");
    expect(result.items).toEqual([BACKEND_ROW, ROLELESS_ROW]);
    expect(result.count).toBe(2);
  });

  test("defaults to the caller's personId from the JWT", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, personId: 6233, source: "asiakas_listForPerson" });
    await runPersonCompanies(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/person/6233/companies");
  });

  test("falls back to the legacy route when the new one is not deployed, and SAYS the answer is narrower", async () => {
    mockClient.get
      .mockRejectedValueOnce(new CliError("not found", 404, null, 5))
      .mockResolvedValueOnce([{ asiakasId: 26, asiakasNimi: "Kalle Urho Oy" }]);

    const result = await runPersonCompanies(mockClient, 5351);

    expect(mockClient.get).toHaveBeenNthCalledWith(1, "/api/cli/person/5351/companies");
    expect(mockClient.get).toHaveBeenNthCalledWith(2, "/api/person/getUserAsiakasList/5351");
    expect(result.source).toBe("person_getUserAsiakasList");
    expect(result.hint).toMatch(/not deployed yet/);
    expect(result.personId).toBe(5351);
    // Same key set as the real route (no shape branch for consumers), but the
    // fields this source CANNOT report are null — never [] / false, which would
    // assert "no roles" / "not a provider" about rows that provably hold a role.
    expect(result.items).toEqual([
      {
        asiakasId: 26,
        name: "Kalle Urho Oy",
        roles: null,
        isTyomaaAsiakas: null,
        isPumppuToimittaja: null,
        isBetoniToimittaja: null,
        isLattiaToimittaja: null,
        activeMembership: true,
      },
    ]);
  });

  test("the fallback unwraps the legacy route's raw mssql recordset shape", async () => {
    mockClient.get
      .mockRejectedValueOnce(new CliError("not found", 404, null, 5))
      .mockResolvedValueOnce({ recordset: [{ asiakasId: 8, asiakasName: "Kalle Urho Oy" }] });

    const result = await runPersonCompanies(mockClient, 5351);
    expect(result.items.map((i) => i.name)).toEqual(["Kalle Urho Oy"]);
  });

  test("a 403 is NOT swallowed into the legacy fallback", async () => {
    mockClient.get.mockRejectedValueOnce(new CliError("forbidden", 403, null, 3));
    await expect(runPersonCompanies(mockClient, 5351)).rejects.toThrow("forbidden");
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });
});

describe("runPersonCompaniesAsToken", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReturnValue(CLAIM_JWT);
  });

  test("reports the token's own asiakasesWithTypes claim, offline", () => {
    const result = runPersonCompaniesAsToken(mockClient);

    expect(mockClient.get).not.toHaveBeenCalled();
    expect(result.source).toBe("jwt-claim");
    expect(result.personId).toBe(6233);
    expect(result.mintedAt).toBe(new Date(1754375517 * 1000).toISOString());
    expect(result.items).toEqual([
      {
        asiakasId: 1349,
        roles: ["asiakasAdmin"],
        isTyomaaAsiakas: false,
        isPumppuToimittaja: true,
        isBetoniToimittaja: false,
        isLattiaToimittaja: false,
      },
      {
        asiakasId: 26,
        roles: [],
        isTyomaaAsiakas: false,
        isPumppuToimittaja: false,
        isBetoniToimittaja: false,
        isLattiaToimittaja: false,
      },
    ]);
  });

  test("accepts the caller's own personId explicitly", () => {
    expect(runPersonCompaniesAsToken(mockClient, 6233).personId).toBe(6233);
  });

  test("mintedAt is null on a compact token — those are signed without iat", () => {
    const noIat = Buffer.from(
      JSON.stringify({ personId: 6233, asiakasesWithTypes: [{ asiakasId: 8, roles: [] }] })
    ).toString("base64url");
    mockClient.getCurrentToken.mockReturnValue(`eyJhbGciOiJIUzI1NiJ9.${noIat}.sig`);

    const result = runPersonCompaniesAsToken(mockClient);

    expect(result.mintedAt).toBeNull();
    expect(result.count).toBe(1);
    // The hint must not claim a snapshot instant it does not have.
    expect(result.hint).toMatch(/null on compact/);
  });

  test("exits 4 for another person — a token cannot answer for someone else", () => {
    const e = captured(() => runPersonCompaniesAsToken(mockClient, 5351));
    expect(e).toBeInstanceOf(CliError);
    expect(e.exitCode).toBe(4);
    expect(e.message).toMatch(/only works for personId 6233/);
  });
});
