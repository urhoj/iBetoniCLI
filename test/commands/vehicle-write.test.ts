import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleTypes,
  runVehicleSearch,
} from "../../src/commands/vehicle/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib vehicle types/search", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
  });

  test("runVehicleTypes hits /api/cli/vehicle/types", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleTypes(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/types");
  });

  test("runVehicleSearch encodes search + limit", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleSearch(mockClient, "ABC", 25);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/list?search=ABC&limit=25"
    );
  });
});
