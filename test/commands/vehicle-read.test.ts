import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleList,
  runVehicleGet,
} from "../../src/commands/vehicle/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib vehicle list/get", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runVehicleList: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/list");
  });

  test("runVehicleList: includes limit and cursor when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ vehicleId: 7, name: "Auto 7" }],
      nextCursor: "next",
      count: 1,
    });
    const result = await runVehicleList(mockClient, {
      limit: 25,
      cursor: "abc",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/list?limit=25&cursor=abc"
    );
    expect(result.count).toBe(1);
  });

  test("runVehicleGet: GET /api/cli/vehicle/get/7", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      vehicleId: 7,
      name: "Auto 7",
    });
    const result = await runVehicleGet(mockClient, 7);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/get/7");
    expect((result as { vehicleId: number }).vehicleId).toBe(7);
  });
});
