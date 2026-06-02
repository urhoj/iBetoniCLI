import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiList,
  runSijaintiGet,
  runSijaintiSetJerry,
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
