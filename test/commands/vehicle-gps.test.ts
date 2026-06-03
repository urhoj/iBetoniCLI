import { describe, test, expect, vi, beforeEach } from "vitest";
import { runVehicleLocations, runVehicleTimeline, runVehicleRoute, runVehicleVisits } from "../../src/commands/vehicle/index.js";
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

describe("ib vehicle timeline", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });
  test("runVehicleTimeline: GET with resolved date", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleTimeline(mockClient, 7, { date: "2026-06-02" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/timeline/7?date=2026-06-02");
  });
});

describe("ib vehicle route", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });
  test("runVehicleRoute: GET with resolved date", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleRoute(mockClient, 7, { date: "2026-06-02" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/route/7?date=2026-06-02");
  });
});

describe("ib vehicle visits", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });
  test("runVehicleVisits: bare path when no days", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleVisits(mockClient, "tyomaa", 17, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/visits/tyomaa/17");
  });
  test("runVehicleVisits: appends days", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleVisits(mockClient, "sijainti", 3, { days: 30 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/visits/sijainti/3?days=30");
  });
  test("runVehicleVisits: rejects bad filterType", async () => {
    await expect(runVehicleVisits(mockClient, "foo", 3, {})).rejects.toThrow();
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});
