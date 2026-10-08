import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runVehicleLocations, runVehicleTimeline, runVehicleRoute, runVehicleVisits, runVehicleRoutePlan, routePlanLegsTable } from "../../src/commands/vehicle/index.js";

const mockClient = mockApiClient();

describe("ib vehicle locations", () => {
  beforeEach(() => { mockClient.get.mockReset(); });

  test("runVehicleLocations: GET /api/cli/vehicle/locations", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleLocations(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/locations");
  });
});

describe("ib vehicle timeline", () => {
  beforeEach(() => { mockClient.get.mockReset(); });
  test("runVehicleTimeline: GET with resolved date", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleTimeline(mockClient, 7, { date: "2026-06-02" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/timeline/7?date=2026-06-02");
  });
});

describe("ib vehicle route", () => {
  beforeEach(() => { mockClient.get.mockReset(); });
  test("runVehicleRoute: GET with resolved date", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleRoute(mockClient, 7, { date: "2026-06-02" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/route/7?date=2026-06-02");
  });
});

describe("ib vehicle route-plan", () => {
  beforeEach(() => { mockClient.get.mockReset(); });
  test("runVehicleRoutePlan: GET with resolved date, payload passed through", async () => {
    const plan = { date: "2026-06-02", planned: { legs: [], totalKm: 0, totalMin: 0, missingLegs: 0 }, actual: null };
    mockClient.get.mockResolvedValueOnce(plan);
    expect(await runVehicleRoutePlan(mockClient, 7, { date: "2026-06-02" })).toBe(plan);
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/route-plan/7?date=2026-06-02");
  });
  test("routePlanLegsTable: legs become rows, totals ride as envelope context", () => {
    const env = routePlanLegsTable({
      vehicle: { vehicleNo: 12, plate: "ABC-123" },
      date: "2026-06-02",
      planned: {
        legs: [
          { from: { kind: "night", name: "Varikko" }, to: { kind: "plant", name: "Tuupakka" }, km: 12.3, min: 15 },
          { from: { kind: "plant", name: "Tuupakka" }, to: { kind: "site", name: null }, km: null, min: null },
        ],
        totalKm: 12.3,
        totalMin: 15,
        missingLegs: 1,
        lookupErrors: 2,
      },
      actual: { totalKm: 40.1, trackKm: 33, odometerKm: 40.1, wasteVisits: 1 },
    });
    expect(env.items).toEqual([
      { from: "Varikko (night)", to: "Tuupakka (plant)", km: 12.3, min: 15 },
      { from: "Tuupakka (plant)", to: "? (site)", km: null, min: null },
    ]);
    expect(env).toMatchObject({ count: 2, nextCursor: null, vehicle: "12 ABC-123", totalKm: 12.3, missingLegs: 1, lookupErrors: 2, actualKm: 40.1, actualKmSource: "odometer", wasteVisits: 1 });
    expect(routePlanLegsTable({ actual: { totalKm: 33, trackKm: 33, odometerKm: null, wasteVisits: 0 } }).actualKmSource).toBe("gps-track");
  });
});

describe("ib vehicle visits", () => {
  beforeEach(() => { mockClient.get.mockReset(); });
  test("runVehicleVisits: bare path when no days", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleVisits(mockClient, "tyomaa", 17, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/visits/tyomaa/17");
  });
  test("runVehicleVisits: appends days", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleVisits(mockClient, "sijainti", 3, { days: 30 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/visits/sijainti/3?days=30");
  });
  test("runVehicleVisits: rejects bad filterType", async () => {
    await expect(runVehicleVisits(mockClient, "foo", 3, {})).rejects.toThrow();
    expect(mockClient.get).not.toHaveBeenCalled();
  });
  test("runVehicleVisits: --date filters to the Helsinki-local day and auto-bounds look-back", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [
        // 08:30 Helsinki (EEST = UTC+3) on 15.4 → kept
        { plate: "A", arrived: "2026-04-15T05:30:00.000Z", departed: "2026-04-15T05:40:00.000Z" },
        // 00:30 Helsinki on 15.4 (still 14.4 in UTC) → kept (TZ-correct filtering)
        { plate: "B", arrived: "2026-04-14T21:30:00.000Z", departed: "2026-04-14T21:40:00.000Z" },
        // 13.4 → dropped
        { plate: "C", arrived: "2026-04-13T10:00:00.000Z", departed: "2026-04-13T10:10:00.000Z" },
      ],
      nextCursor: null, count: 3, gpsAvailable: true,
    });
    const res = await runVehicleVisits(mockClient, "sijainti", 60, { date: "2026-04-15" });
    expect(mockClient.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/cli\/vehicle\/visits\/sijainti\/60\?days=\d+$/)
    );
    expect(res.items.map((i) => i.plate)).toEqual(["A", "B"]);
    expect(res.count).toBe(2);
  });
  test("runVehicleVisits: explicit --days wins over the derived look-back", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [], nextCursor: null, count: 0, gpsAvailable: true });
    await runVehicleVisits(mockClient, "sijainti", 60, { days: 90, date: "2026-04-15" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/vehicle/visits/sijainti/60?days=90");
  });
  test("runVehicleVisits: rejects a malformed date", async () => {
    await expect(
      runVehicleVisits(mockClient, "sijainti", 60, { date: "15.4.2026" })
    ).rejects.toThrow(/date/);
    expect(mockClient.get).not.toHaveBeenCalled();
  });
});
