import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runCompanyList,
  runCompanyCurrent,
} from "../../src/commands/company/index.js";

const mockClient = mockApiClient();

/** Build a minimal unsigned JWT (header.body.sig) with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("ib company", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReset();
  });

  test("runCompanyList: GETs /api/company-selection/available and projects envelope", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [
        { asiakasId: 1, name: "A" },
        { asiakasId: 2, name: "B" },
      ],
      currentCompanyId: 1,
    });
    mockClient.getCurrentToken.mockReturnValue(
      jwt({
        asiakasesWithTypes: [
          { asiakasId: 1, roles: ["asiakasAdmin", "keikkaHandler"] },
          { asiakasId: 2, roles: [] },
        ],
      })
    );
    const out = await runCompanyList(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/company-selection/available"
    );
    expect(out).toEqual({
      items: [
        {
          asiakasId: 1,
          name: "A",
          current: true,
          roles: ["asiakasAdmin", "keikkaHandler"],
        },
        { asiakasId: 2, name: "B", current: false, roles: [] },
      ],
      nextCursor: null,
      count: 2,
    });
  });

  test("runCompanyList: a company absent from the JWT gets roles: [] (stale token)", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [
        { asiakasId: 1, name: "A" },
        { asiakasId: 7, name: "Joined since the token was minted" },
      ],
      currentCompanyId: 1,
    });
    mockClient.getCurrentToken.mockReturnValue(
      jwt({ asiakasesWithTypes: [{ asiakasId: 1, roles: ["asiakasAdmin"] }] })
    );
    const out = await runCompanyList(mockClient);
    expect(out.items.map((i) => i.roles)).toEqual([["asiakasAdmin"], []]);
  });

  // The network half already succeeded — an undecodable token must degrade to
  // "no roles known", never fail the whole read.
  test("runCompanyList: an undecodable token degrades to roles: [], not a throw", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [{ asiakasId: 1, name: "A" }],
      currentCompanyId: 1,
    });
    mockClient.getCurrentToken.mockReturnValue("not-a-jwt");
    const out = await runCompanyList(mockClient);
    expect(out.items).toEqual([
      { asiakasId: 1, name: "A", current: true, roles: [] },
    ]);
  });

  test("runCompanyList: backend Finnish `asiakasNimi` still wins the name", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [{ asiakasId: 1, asiakasNimi: "Kalle Urho Oy" }],
      currentCompanyId: 1,
    });
    mockClient.getCurrentToken.mockReturnValue(jwt({}));
    const out = await runCompanyList(mockClient);
    expect(out.items[0]).toEqual({
      asiakasId: 1,
      name: "Kalle Urho Oy",
      current: true,
      roles: [],
    });
  });

  // fb#1766: every sibling list takes --search; a caller reaching for it by
  // analogy got exit 4. Client-side over the membership set — no new route.
  test("runCompanyList --search: case-insensitive substring on name, client-side, count follows", async () => {
    mockClient.get.mockResolvedValue({
      companies: [
        { asiakasId: 27, name: "Betomik Oy " },
        { asiakasId: 8, name: "PumiNet Oy" },
        { asiakasId: 30, asiakasNimi: "Kalle Urho Oy" },
      ],
      currentCompanyId: 8,
    });
    mockClient.getCurrentToken.mockReturnValue(jwt({}));

    const hit = await runCompanyList(mockClient, { search: "betoMIK" });
    expect(hit.items.map((c) => c.asiakasId)).toEqual([27]);
    expect(hit.count).toBe(1);
    expect(mockClient.get).toHaveBeenLastCalledWith("/api/company-selection/available");

    const miss = await runCompanyList(mockClient, { search: "nope" });
    expect(miss.items).toEqual([]);
    expect(miss.count).toBe(0);

    // Blank/whitespace search = no filter, same as omitting it.
    expect((await runCompanyList(mockClient, { search: "  " })).count).toBe(3);
  });

  test("runCompanyCurrent: returns the active company record", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [
        { asiakasId: 1, name: "A" },
        { asiakasId: 2, name: "B" },
      ],
      currentCompanyId: 2,
    });
    const out = await runCompanyCurrent(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/company-selection/available"
    );
    expect(out).toEqual({ asiakasId: 2, name: "B" });
  });

  test("runCompanyCurrent: throws when no current company in response", async () => {
    mockClient.get.mockResolvedValueOnce({
      companies: [{ asiakasId: 1, name: "A" }],
      currentCompanyId: 99,
    });
    await expect(runCompanyCurrent(mockClient)).rejects.toThrow(
      /No current company/
    );
  });
});
