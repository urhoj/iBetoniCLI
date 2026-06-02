import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiList,
  runSijaintiGet,
  runSijaintiSetJerry,
  runSijaintiTypes,
  runSijaintiGeocode,
  runSijaintiClosest,
  runSijaintiDistance,
} from "../../src/commands/sijainti/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib sijainti list/get", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runSijaintiList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runSijaintiList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/sijainti/list");
  });

  test("runSijaintiList: includes type and limit when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ sijaintiId: 99, name: "Helsinki Asema" }],
      nextCursor: null,
      count: 1,
    });
    const result = await runSijaintiList(mockClient, {
      type: "asema",
      limit: 100,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/sijainti/list?type=asema&limit=100"
    );
    expect(result.count).toBe(1);
  });

  test("runSijaintiGet: GET /api/geocode/sijainti/get/99 (geocode route, not /api/cli/)", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sijaintiId: 99,
      name: "Helsinki Asema",
    });
    const result = await runSijaintiGet(mockClient, 99);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/geocode/sijainti/get/99"
    );
    expect((result as { sijaintiId: number }).sijaintiId).toBe(99);
  });

  test("runSijaintiList: includes validAtDate and includeDeleted when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runSijaintiList(mockClient, {
      validAt: "2026-06-02",
      includeDeleted: true,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/sijainti/list?validAtDate=2026-06-02&includeDeleted=1"
    );
  });
});

describe("ib sijainti set-jerry", () => {
  const get = mockClient.get as ReturnType<typeof vi.fn>;
  const post = mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
  });

  test("--on reads the row then POSTs updateSijainti with the sentinel, preserving other fields", async () => {
    get.mockResolvedValueOnce({
      sijaintiId: 42,
      sijaintiNimi: "Helsinki varikko",
      sijaintiOsoite1: "Asemakatu 1",
      lat: 60.17,
      lng: 24.94,
      jerryActiveUntil: null,
    });
    post.mockResolvedValueOnce({ ok: true });
    await runSijaintiSetJerry(mockClient, 42, true, { reason: "pilot" });
    expect(get).toHaveBeenCalledWith("/api/geocode/sijainti/get/42");
    expect(post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      {
        sijaintiId: 42,
        sijaintiNimi: "Helsinki varikko",
        sijaintiOsoite1: "Asemakatu 1",
        lat: 60.17,
        lng: 24.94,
        jerryActiveUntil: "9999-12-31 23:59:59",
      },
      { headers: { "X-Action-Reason": "pilot" } }
    );
  });

  test("--off writes null jerryActiveUntil and forwards --dry-run", async () => {
    get.mockResolvedValueOnce({ sijaintiId: 42, sijaintiNimi: "X" });
    post.mockResolvedValueOnce({ dryRun: true });
    await runSijaintiSetJerry(mockClient, 42, false, { dryRun: true });
    expect(post).toHaveBeenCalledWith(
      "/api/geocode/updateSijainti",
      { sijaintiId: 42, sijaintiNimi: "X", jerryActiveUntil: null },
      { headers: { "X-Dry-Run": "1" } }
    );
  });
});

describe("ib sijainti types", () => {
  const get = mockClient.get as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get.mockReset();
  });

  test("runSijaintiTypes: GET /api/geocode/sijaintiTypes, wraps into envelope", async () => {
    get.mockResolvedValueOnce([
      { sijaintiTypeId: 1, sijaintiTypeSelite: "Betoniasema" },
      { sijaintiTypeId: 6, sijaintiTypeSelite: "Toimipiste / konttori" },
    ]);
    const result = await runSijaintiTypes(mockClient);
    expect(get).toHaveBeenCalledWith("/api/geocode/sijaintiTypes");
    expect(result).toEqual({
      items: [
        { sijaintiTypeId: 1, selite: "Betoniasema" },
        { sijaintiTypeId: 6, selite: "Toimipiste / konttori" },
      ],
      nextCursor: null,
      count: 2,
    });
  });

  test("runSijaintiTypes: --jerry appends ?useJerry=1", async () => {
    get.mockResolvedValueOnce([]);
    await runSijaintiTypes(mockClient, true);
    expect(get).toHaveBeenCalledWith("/api/geocode/sijaintiTypes?useJerry=1");
  });
});

describe("ib sijainti geocode", () => {
  const post = mockClient.post as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    post.mockReset();
  });

  test("runSijaintiGeocode: POST /api/geocode/getLatLng with {osoite}, returns raw", async () => {
    post.mockResolvedValueOnce({ status: "OK", lat: 60.17, lng: 24.94 });
    const result = await runSijaintiGeocode(
      mockClient,
      "Mannerheimintie 1, Helsinki"
    );
    expect(post).toHaveBeenCalledWith("/api/geocode/getLatLng", {
      osoite: "Mannerheimintie 1, Helsinki",
    });
    expect((result as { lat: number }).lat).toBe(60.17);
  });
});

describe("ib sijainti closest", () => {
  const get = mockClient.get as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get.mockReset();
  });

  test("uses given --asiakas, passes 0 as ignored sijaintiId, tidies response", async () => {
    get.mockResolvedValueOnce({
      matkaM: 0,
      min: 0,
      success: true,
      closestSijainti: { sijaintiId: 7, sijaintiNimi: "Asema A" },
      closestDistance: 12.4,
    });
    const result = await runSijaintiClosest(mockClient, {
      tyomaaId: 555,
      sijaintiTypeId: 1,
      asiakasId: 26,
    });
    expect(get).toHaveBeenCalledWith(
      "/api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa/555/0/1/26"
    );
    expect(result).toEqual({
      closestSijainti: { sijaintiId: 7, sijaintiNimi: "Asema A" },
      closestDistance: 12.4,
    });
  });

  test("resolves asiakasId from active company when --asiakas omitted", async () => {
    get
      .mockResolvedValueOnce({ currentCompanyId: 1349 }) // /api/company-selection/available
      .mockResolvedValueOnce({ closestSijainti: null, closestDistance: null });
    await runSijaintiClosest(mockClient, { tyomaaId: 555, sijaintiTypeId: 1 });
    expect(get).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/geocode/sijainti/getClosestAsiakasSijaintiForTyomaa/555/0/1/1349"
    );
  });
});

describe("ib sijainti distance", () => {
  const get = mockClient.get as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get.mockReset();
  });

  test("coords for both points, resolves owner asiakasId", async () => {
    get
      .mockResolvedValueOnce({ currentCompanyId: 1349 }) // available
      .mockResolvedValueOnce({ matkaM: 12345, matkaAika: 18 }); // driving distance
    const result = await runSijaintiDistance(
      mockClient,
      "60.17,24.94",
      "61.49,23.78"
    );
    expect(get).toHaveBeenNthCalledWith(1, "/api/company-selection/available");
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/geocode/getDrivingDistance/60.17/24.94/61.49/23.78/1349"
    );
    expect(result).toMatchObject({ matkaM: 12345, matkaMin: 18 });
  });

  test("resolves a sijaintiId argument to its coordinates", async () => {
    get
      .mockResolvedValueOnce({ sijaintiId: 7, lat: 60.17, lng: 24.94 }) // get sijainti 7
      .mockResolvedValueOnce({ currentCompanyId: 26 }) // available
      .mockResolvedValueOnce({ matkaM: 500, matkaAika: 2 });
    const result = await runSijaintiDistance(mockClient, "7", "60.0,24.0");
    expect(get).toHaveBeenNthCalledWith(1, "/api/geocode/sijainti/get/7");
    expect(get).toHaveBeenNthCalledWith(
      3,
      "/api/geocode/getDrivingDistance/60.17/24.94/60/24/26"
    );
    expect((result as { matkaM: number }).matkaM).toBe(500);
  });
});
