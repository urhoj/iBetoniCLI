import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runCustomerList,
  runCustomerGet,
  runCustomerSearch,
  runCustomerModulesReport,
  runCustomerWorksites,
  projectCustomerRow,
} from "../../src/commands/customer/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib customer list/get/search", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runCustomerList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runCustomerList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/list");
  });

  test("runCustomerList: includes limit and cursor when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ asiakasId: 1349, name: "BetoniJerry" }],
      nextCursor: "abc",
      count: 1,
    });
    const result = await runCustomerList(mockClient, {
      limit: 50,
      cursor: "abc",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?limit=50&cursor=abc"
    );
    expect(result.count).toBe(1);
  });

  test("runCustomerList: appends full=1 and ids when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runCustomerList(mockClient, { full: true, ids: [26, 42, 1349] });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?full=1&ids=26%2C42%2C1349"
    );
  });

  test("runCustomerList: appends include (contacts,sijainnit) when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runCustomerList(mockClient, { full: true, ids: [1], include: ["contacts", "sijainnit"] });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?full=1&ids=1&include=contacts%2Csijainnit"
    );
  });

  test("runCustomerGet: GET /api/cli/customer/get/1349", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      asiakasId: 1349,
      name: "BetoniJerry",
    });
    const result = await runCustomerGet(mockClient, 1349);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/customer/get/1349");
    expect((result as { asiakasId: number }).asiakasId).toBe(1349);
  });

  test("runCustomerSearch: GET /api/asiakas/search?searchString=<query>", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasId: 1349, name: "BetoniJerry" },
    ]);
    await runCustomerSearch(mockClient, "Betoni");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/asiakas/search?searchString=Betoni"
    );
  });

  test("runCustomerSearch: URL-encodes special characters in query", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runCustomerSearch(mockClient, "Acme & Co");
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/asiakas/search?searchString=Acme+%26+Co"
    );
  });

  test("runCustomerSearch forwards --limit as a query param", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await runCustomerSearch(mockClient, "Example", 25);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/asiakas/search?searchString=Example&limit=25"
    );
  });

  test("runCustomerWorksites: GET asiakasTyomaaList, wraps array into envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { tyomaaId: 7, tyomaaNimi: "Site A", tyomaaOsoite1: "Main 1", tyomaaOsoite4: "Helsinki" },
    ]);
    const result = await runCustomerWorksites(mockClient, 1349);
    expect(mockClient.get).toHaveBeenCalledWith("/api/tyomaa/asiakasTyomaaList/1349");
    expect(result).toEqual({
      items: [{ tyomaaId: 7, name: "Site A", address: "Main 1", city: "Helsinki" }],
      nextCursor: null, count: 1,
    });
  });

  test("runCustomerList surfaces backend 'truncated' on the envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ asiakasId: 1 }],
      truncated: true,
      nextCursor: null,
      count: 1,
    });
    const out = await runCustomerList(mockClient, { limit: 1 });
    expect(out).toMatchObject({ truncated: true });
  });

  test("runCustomerList: appends fields and sijaintiTypes when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runCustomerList(mockClient, {
      ids: [26],
      include: ["sijainnit"],
      fields: ["name", "address"],
      sijaintiTypes: [1, 2],
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?ids=26&include=sijainnit&fields=name%2Caddress&sijaintiTypes=1%2C2"
    );
  });

  test("runCustomerList: appends since and sort when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [], nextCursor: null, count: 0,
    });
    await runCustomerList(mockClient, { since: "2026-07-08", sort: "registered" });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/list?since=2026-07-08&sort=registered"
    );
  });

  test("runCustomerList: re-applies fields/sijainti-types client-side over a full backend row", async () => {
    // Simulate an OLDER backend that ignored the params and returned full rows.
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          asiakasId: 26,
          name: "Rudus",
          yTunnus: "1-1",
          city: "Helsinki",
          companyDescription: "concrete",
          sijainnit: [
            { sijaintiId: 1, sijaintiTypeId: 1, name: "Asema A" },
            { sijaintiId: 2, sijaintiTypeId: 9, name: "Jäteasema" },
          ],
        },
      ],
      nextCursor: null,
      count: 1,
    });
    const out = await runCustomerList(mockClient, {
      ids: [26],
      include: ["sijainnit"],
      fields: ["name"],
      sijaintiTypes: [1],
    });
    expect(out.items).toEqual([
      {
        asiakasId: 26,
        name: "Rudus",
        sijainnit: [{ sijaintiId: 1, sijaintiTypeId: 1, name: "Asema A" }],
      },
    ]);
  });

  test("projectCustomerRow: keeps asiakasId, projects requested fields, preserves include arrays", () => {
    const row = {
      asiakasId: 26,
      name: "Rudus",
      yTunnus: "1-1",
      city: "Helsinki",
      contacts: [{ personId: 9, name: "X" }],
      sijainnit: [{ sijaintiId: 1, sijaintiTypeId: 2 }],
    };
    expect(projectCustomerRow(row, ["name"], undefined)).toEqual({
      asiakasId: 26,
      name: "Rudus",
      contacts: [{ personId: 9, name: "X" }],
      sijainnit: [{ sijaintiId: 1, sijaintiTypeId: 2 }],
    });
  });

  test("projectCustomerRow: filters sijainnit by type; returns row unchanged with no opts", () => {
    const row = {
      asiakasId: 26,
      sijainnit: [
        { sijaintiId: 1, sijaintiTypeId: 1 },
        { sijaintiId: 2, sijaintiTypeId: 9 },
      ],
    };
    expect(projectCustomerRow(row, undefined, [1])).toEqual({
      asiakasId: 26,
      sijainnit: [{ sijaintiId: 1, sijaintiTypeId: 1 }],
    });
    expect(projectCustomerRow(row, undefined, undefined)).toBe(row);
  });

  test("runCustomerModulesReport: GET /api/cli/customer/modules/1349, returns state verbatim", async () => {
    const state = {
      asiakasId: 1349,
      roolit: {
        isTyomaaAsiakas: false,
        isPumppuToimittaja: true,
        isBetoniToimittaja: false,
        isLattiaToimittaja: false,
      },
      modules: {
        jerry: true,
        henkilot: true,
        sijainnit: false,
        ajoneuvot: false,
        tiedostot: false,
        weather: false,
        lomaseuranta: false,
        shareorders: false,
      },
    };
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(state);
    const result = await runCustomerModulesReport(mockClient, 1349);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/customer/modules/1349"
    );
    expect(result).toEqual(state);
  });
});
