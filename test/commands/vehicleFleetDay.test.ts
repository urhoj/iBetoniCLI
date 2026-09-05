import { describe, test, expect, vi } from "vitest";
import { runVehicleFleetDay } from "../../src/commands/vehicle/index.js";

describe("ib vehicle fleet-day", () => {
  test("GETs /api/dashboard/kentta with the resolved date", async () => {
    const client = { get: vi.fn(async () => ({ date: "2026-09-05", orders: [] })) };
    const out = await runVehicleFleetDay(client as never, { date: "2026-09-05" });
    expect(client.get).toHaveBeenCalledWith("/api/dashboard/kentta?date=2026-09-05");
    expect(out).toEqual({ date: "2026-09-05", orders: [] });
  });
  test("omits the query string when no date is given (server resolves Helsinki today)", async () => {
    const client = { get: vi.fn(async () => ({})) };
    await runVehicleFleetDay(client as never, {});
    expect(client.get).toHaveBeenCalledWith("/api/dashboard/kentta");
  });
});
