import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runSijaintiList,
  runSijaintiGet,
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
