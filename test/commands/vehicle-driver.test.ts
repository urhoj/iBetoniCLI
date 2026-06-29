import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleDriverBoard,
  runVehicleDriverGaps,
  runVehicleDriverAvailable,
  runVehicleDriverWho,
  runVehicleDriverHistory,
  runVehicleDriverAssign,
  runVehicleDriverClear,
  runVehicleDefaultGet,
  runVehicleDefaultSet,
} from "../../src/commands/vehicle/driver.js";
import type { ApiClient } from "../../src/api/client.js";

const c = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

const LIST = { items: [], nextCursor: null, count: 0 };
const get = () => c.get as ReturnType<typeof vi.fn>;
const post = () => c.post as ReturnType<typeof vi.fn>;

describe("ib vehicle driver reads", () => {
  beforeEach(() => vi.clearAllMocks());

  test("board resolves date alias to yyyymmdd path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverBoard(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/board/20260610");
  });

  test("gaps hits the gaps path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverGaps(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/gaps/20260610");
  });

  test("available hits the available path", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverAvailable(c, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/available/20260610");
  });

  test("who hits /who/:vehicleId/:yyyymmdd", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, date: "2026-06-10", driver: null });
    await runVehicleDriverWho(c, 53, "2026-06-10");
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/who/53/20260610");
  });

  test("history encodes vehicleId + from/to", async () => {
    get().mockResolvedValueOnce(LIST);
    await runVehicleDriverHistory(c, 53, { from: "2026-06-01", to: "2026-06-30" });
    expect(c.get).toHaveBeenCalledWith("/api/cli/driver/history/53?from=2026-06-01&to=2026-06-30");
  });
});

describe("ib vehicle driver writes", () => {
  beforeEach(() => vi.clearAllMocks());

  test("assign posts {vehicleId,personId,yyyymmdd} with reason header", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDriverAssign(c, 53, 555, "2026-06-10", { reason: "auto-fill" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/assign",
      { vehicleId: 53, personId: 555, yyyymmdd: 20260610 },
      { headers: { "X-Action-Reason": "auto-fill" } }
    );
  });

  test("assign --dry-run sends X-Dry-Run", async () => {
    post().mockResolvedValueOnce({ dryRun: true });
    await runVehicleDriverAssign(c, 53, 555, "2026-06-10", { dryRun: true, reason: "preview" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/assign",
      { vehicleId: 53, personId: 555, yyyymmdd: 20260610 },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "preview" } }
    );
  });

  test("clear posts {vehicleId,yyyymmdd} with reason header", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDriverClear(c, 53, "2026-06-10", { reason: "breakdown" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/cli/driver/clear",
      { vehicleId: 53, yyyymmdd: 20260610 },
      { headers: { "X-Action-Reason": "breakdown" } }
    );
  });
});

describe("ib vehicle driver default", () => {
  beforeEach(() => vi.clearAllMocks());

  test("get projects defaultDriverId off the vehicle record", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, defaultDriverId: 555, plate: "ABC-1" });
    const out = await runVehicleDefaultGet(c, 53);
    expect(c.get).toHaveBeenCalledWith("/api/cli/vehicle/get/53");
    expect(out).toEqual({ vehicleId: 53, defaultDriverPersonId: 555 });
  });

  test("get yields null when no default driver", async () => {
    get().mockResolvedValueOnce({ vehicleId: 53, plate: "ABC-1" });
    const out = await runVehicleDefaultGet(c, 53);
    expect(out).toEqual({ vehicleId: 53, defaultDriverPersonId: null });
  });

  test("set posts {vehicleId,personId} to setDefaultPumppari", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDefaultSet(c, 53, 555, { reason: "permanent driver" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/setDefaultPumppari",
      { vehicleId: 53, personId: 555 },
      { headers: { "X-Action-Reason": "permanent driver" } }
    );
  });

  test("clear posts personId:null to setDefaultPumppari", async () => {
    post().mockResolvedValueOnce({ success: true });
    await runVehicleDefaultSet(c, 53, null, { reason: "driver left" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/setDefaultPumppari",
      { vehicleId: 53, personId: null },
      { headers: { "X-Action-Reason": "driver left" } }
    );
  });
});
