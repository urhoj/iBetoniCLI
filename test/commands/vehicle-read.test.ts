import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runVehicleList,
  runVehicleGet,
  runVehicleStatus,
} from "../../src/commands/vehicle/index.js";

const mockClient = mockApiClient();

describe("ib vehicle list/get", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("runVehicleList: hits bare path when no opts set", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/list");
  });

  test("runVehicleList: includes limit and cursor when set", async () => {
    mockClient.get.mockResolvedValueOnce({
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

  test("runVehicleList: maps the narrowing filters to query params", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleList(mockClient, {
      deleted: true,
      gridOnly: true,
      validOn: "2026-06-08",
      type: 1,
    });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/list?deleted=1&gridOnly=1&validOn=2026-06-08&type=1"
    );
  });

  test("runVehicleList: falsy filters are omitted from the query", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleList(mockClient, { deleted: false, gridOnly: false });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/list");
  });

  test("runVehicleList: appends asiakas for a cross-tenant read", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleList(mockClient, { asiakas: 1380 });
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/list?asiakas=1380"
    );
  });

  test("runVehicleGet: GET /api/cli/vehicle/get/7", async () => {
    mockClient.get.mockResolvedValueOnce({
      vehicleId: 7,
      name: "Auto 7",
    });
    const result = await runVehicleGet(mockClient, 7);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/get/7");
    expect((result as { vehicleId: number }).vehicleId).toBe(7);
  });

  test("runVehicleGet: appends ?asiakas= for a cross-tenant read", async () => {
    mockClient.get.mockResolvedValueOnce({
      vehicleId: 159,
      name: "Pumi 24 m",
    });
    await runVehicleGet(mockClient, 159, 1380);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/get/159?asiakas=1380"
    );
  });

  test("runVehicleStatus: GET /api/cli/vehicle/status/7", async () => {
    mockClient.get.mockResolvedValueOnce({
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
});
