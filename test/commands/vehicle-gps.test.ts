import { describe, test, expect, vi, beforeEach } from "vitest";
import { runVehicleLocations } from "../../src/commands/vehicle/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("ib vehicle locations", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });

  test("runVehicleLocations: GET /api/cli/vehicle/locations", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleLocations(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/locations");
  });
});
