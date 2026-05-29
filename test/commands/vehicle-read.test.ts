import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleList,
  runVehicleGet,
  runVehicleStatus,
  runVehicleDrivers,
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

  test("runVehicleStatus: GET /api/cli/vehicle/status/7", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      vehicleId: 7,
      plate: "ABC-123",
      currentDriver: null,
      currentKeikka: null,
      lastGpsPing: null,
    });
    const result = await runVehicleStatus(mockClient, 7);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/status/7");
    expect((result as { plate: string }).plate).toBe("ABC-123");
  });

  test("runVehicleDrivers: hits bare path when no opts set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleDrivers(mockClient, 7, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/drivers/7");
  });

  test("runVehicleDrivers: appends from/to when set", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [{ pvm: "2026-05-29", driverId: 555 }],
      nextCursor: null,
      count: 1,
    });
    const result = await runVehicleDrivers(mockClient, 7, {
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/drivers/7?from=2026-05-01&to=2026-05-31"
    );
    expect(result.count).toBe(1);
  });
});
