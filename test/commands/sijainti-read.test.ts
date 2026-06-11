import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiList,
  runSijaintiListJoined,
  runSijaintiGet,
  runSijaintiSetJerry,
  runSijaintiTypes,
  runSijaintiGeocode,
  runSijaintiClosest,
  runSijaintiDistance,
  resolveSijaintiTypeId,
  sijaintiRowMatches,
} from "../../src/commands/sijainti/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

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

  test("runSijaintiList: includes search and scope=all when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runSijaintiList(mockClient, { search: "kivikko", all: true });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/sijainti/list?search=kivikko&scope=all"
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

  test("--on POSTs updateSijainti with the sentinel + a default delivery radius, preserving other fields", async () => {
    get.mockResolvedValueOnce({
      sijaintiId: 42,
      sijaintiNimi: "Helsinki varikko",
      sijaintiOsoite1: "Asemakatu 1",
      lat: 60.17,
      lng: 24.94,
      jerryActiveUntil: null,
      // no maxDeliveryDistance → enrol defaults it to 50 km (else it covers nothing)
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
        maxDeliveryDistance: 50,
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

  test("normalizes the backend 999999999 no-result sentinel to null", async () => {
    get.mockResolvedValueOnce({ closestSijainti: null, closestDistance: 999999999 });
    const result = await runSijaintiClosest(mockClient, {
      tyomaaId: 555,
      sijaintiTypeId: 1,
      asiakasId: 26,
    });
    expect(result).toEqual({ closestSijainti: null, closestDistance: null });
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

  test("throws a clear error when the active company can't be resolved (--asiakas omitted)", async () => {
    get.mockResolvedValueOnce({ currentCompanyId: undefined }); // backend: token lacks ownerAsiakasId
    await expect(
      runSijaintiClosest(mockClient, { tyomaaId: 555, sijaintiTypeId: 1 })
    ).rejects.toThrow(/active company/);
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
    expect(get).toHaveBeenCalledWith("/api/company-selection/available");
    expect(get).toHaveBeenCalledWith(
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
    expect(get).toHaveBeenCalledWith("/api/geocode/sijainti/get/7");
    expect(get).toHaveBeenCalledWith(
      "/api/geocode/getDrivingDistance/60.17/24.94/60/24/26"
    );
    expect((result as { matkaM: number }).matkaM).toBe(500);
  });

  test("rejects a trailing-comma coord token instead of treating it as lng=0", async () => {
    await expect(
      runSijaintiDistance(mockClient, "60.17,", "1,2")
    ).rejects.toThrow(/invalid point/);
    expect(get).not.toHaveBeenCalled();
  });
});

const TYPE_ROWS = [
  { sijaintiTypeId: 1, sijaintiTypeSelite: "Betoniasema" },
  { sijaintiTypeId: 2, sijaintiTypeSelite: "Jäteasema" },
  { sijaintiTypeId: 3, sijaintiTypeSelite: "Varikko" },
];
const TYPE_ITEMS = TYPE_ROWS.map((t) => ({
  sijaintiTypeId: t.sijaintiTypeId,
  selite: t.sijaintiTypeSelite,
}));

describe("resolveSijaintiTypeId", () => {
  test("numeric input passes through", () => {
    expect(resolveSijaintiTypeId(TYPE_ITEMS, "3")).toBe(3);
  });
  test("exact name match, case-insensitive", () => {
    expect(resolveSijaintiTypeId(TYPE_ITEMS, "betoniasema")).toBe(1);
  });
  test("unique substring match (jäte → Jäteasema)", () => {
    expect(resolveSijaintiTypeId(TYPE_ITEMS, "jäte")).toBe(2);
  });
  test("ambiguous substring → CliError exit 4 listing matches", () => {
    try {
      resolveSijaintiTypeId(TYPE_ITEMS, "asema");
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(4);
      expect((e as CliError).message).toMatch(/Betoniasema.*Jäteasema/);
    }
  });
  test("unknown name → CliError exit 4 listing valid types", () => {
    try {
      resolveSijaintiTypeId(TYPE_ITEMS, "satama");
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(4);
      expect((e as CliError).message).toMatch(/1=Betoniasema/);
    }
  });
});

describe("sijaintiRowMatches", () => {
  test("matches name/address/typeName case-insensitively; ignores non-strings", () => {
    const row = { name: "Kamppi varikko", address: "Malminkatu 2", typeName: "Jäteasema", coords: null };
    expect(sijaintiRowMatches(row, "VARIKKO")).toBe(true);
    expect(sijaintiRowMatches(row, "malminkatu")).toBe(true);
    expect(sijaintiRowMatches(row, "jäteasema")).toBe(true);
    expect(sijaintiRowMatches(row, "betoniasema")).toBe(false);
    expect(sijaintiRowMatches({ name: null, address: null, typeName: null }, "x")).toBe(false);
  });
});

describe("runSijaintiListJoined", () => {
  const get = mockClient.get as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/geocode/sijaintiTypes")) return TYPE_ROWS;
      if (path.startsWith("/api/cli/sijainti/list")) {
        return {
          items: [
            { sijaintiId: 1, name: "Helsinki asema", address: "Asemakatu 1", coords: null, type: 1, jerryActiveUntil: null },
            { sijaintiId: 2, name: "Kaatopaikka", address: "Jätekuja 9", coords: null, type: 2, jerryActiveUntil: null },
            { sijaintiId: 3, name: "Varikko Itä", address: null, coords: null, type: 99, jerryActiveUntil: null },
          ],
          nextCursor: null,
          count: 3,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  });

  test("joins typeName onto every row (null for unknown type ids)", async () => {
    const result = await runSijaintiListJoined(mockClient, {});
    expect(get).toHaveBeenCalledWith("/api/geocode/sijaintiTypes");
    expect(get).toHaveBeenCalledWith("/api/cli/sijainti/list");
    expect(result.items.map((r) => r.typeName)).toEqual([
      "Betoniasema",
      "Jäteasema",
      null,
    ]);
  });

  test("--type NAME resolves to its id in the backend query", async () => {
    await runSijaintiListJoined(mockClient, { type: "jäteasema" });
    expect(get).toHaveBeenCalledWith("/api/cli/sijainti/list?type=2");
  });

  test("--search fetches at the 500 cap, forwards the query server-side and filters by name/address/typeName", async () => {
    const result = await runSijaintiListJoined(mockClient, { search: "jäte" });
    // search is forwarded for server-side pre-filtering (newer backends);
    // the client-side filter below covers older backends that ignore it.
    expect(get).toHaveBeenCalledWith(
      "/api/cli/sijainti/list?limit=500&search=j%C3%A4te"
    );
    // "jäte" hits Kaatopaikka twice (address Jätekuja + typeName Jäteasema) — once
    expect(result.items.map((r) => r.sijaintiId)).toEqual([2]);
    expect(result.count).toBe(1);
  });

  test("--search slices filtered hits to --limit", async () => {
    const result = await runSijaintiListJoined(mockClient, { search: "a", limit: 2 });
    expect(get).toHaveBeenCalledWith("/api/cli/sijainti/list?limit=500&search=a");
    expect(result.items).toHaveLength(2);
  });

  test("--all forwards scope=all", async () => {
    await runSijaintiListJoined(mockClient, { all: true });
    expect(get).toHaveBeenCalledWith("/api/cli/sijainti/list?scope=all");
  });

  test("propagates the backend truncated flag", async () => {
    // Regression guard: the joined orchestrator rebuilds the envelope and used
    // to DROP the backend's truncated signal — a default-limit scope=all list
    // silently capped at 100 then read as complete (38/138 rows hidden in the
    // 2026-06-11 Jerry investigation).
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/geocode/sijaintiTypes")) return TYPE_ROWS;
      if (path.startsWith("/api/cli/sijainti/list")) {
        return {
          items: [{ sijaintiId: 1, name: "A", address: null, coords: null, type: 1, jerryActiveUntil: null }],
          nextCursor: null,
          count: 1,
          truncated: true,
        };
      }
      throw new Error(`unexpected GET ${path}`);
    });
    const result = await runSijaintiListJoined(mockClient, {});
    expect(result.truncated).toBe(true);
  });

  test("omits truncated when the backend does not send it (older backend)", async () => {
    const result = await runSijaintiListJoined(mockClient, {});
    expect(result.truncated).toBeUndefined();
  });

  test("--search sets truncated when the client-side slice cuts matched rows", async () => {
    const result = await runSijaintiListJoined(mockClient, { search: "a", limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
