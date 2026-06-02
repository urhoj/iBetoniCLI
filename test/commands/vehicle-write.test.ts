import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleTypes,
  runVehicleSearch,
  runVehicleCreate,
  runVehicleUpdate,
  runVehicleDatesList,
  runVehicleDatesExpiring,
  runVehicleDriversAssign,
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

describe("runVehicleCreate", () => {
  const c = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  const JWT =
    "e30." +
    Buffer.from(
      JSON.stringify({ ownerAsiakasId: 1349, personId: 1 })
    ).toString("base64url") +
    ".sig";
  beforeEach(() => {
    vi.clearAllMocks();
    (c.getCurrentToken as ReturnType<typeof vi.fn>).mockReturnValue(JWT);
  });

  test("non-dry-run: new then save with merged body", async () => {
    (c.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ vehicleId: 88 })
      .mockResolvedValueOnce({ vehicleId: 88 });
    await runVehicleCreate(
      c,
      { vehicleRegNo: "ABC-9", vehicleM3: 8 },
      { reason: "fleet add" }
    );
    expect(c.post).toHaveBeenNthCalledWith(1, "/api/vehicle/new/1349", {}, {
      headers: { "X-Action-Reason": "fleet add" },
    });
    expect(c.post).toHaveBeenNthCalledWith(
      2,
      "/api/vehicle/save",
      expect.objectContaining({
        vehicleId: 88,
        vehicleRegNo: "ABC-9",
        vehicleM3: 8,
        asiakasId: 1349,
      }),
      { headers: { "X-Action-Reason": "fleet add" } }
    );
  });

  test("dry-run: only /new with X-Dry-Run, no save", async () => {
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dryRun: true,
      wouldCreate: { vehicleId: null },
    });
    await runVehicleCreate(c, { vehicleRegNo: "ABC-9" }, { dryRun: true });
    expect(c.post).toHaveBeenCalledTimes(1);
    expect(c.post).toHaveBeenCalledWith("/api/vehicle/new/1349", {}, {
      headers: { "X-Dry-Run": "1" },
    });
  });
});

describe("runVehicleUpdate", () => {
  const c = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  beforeEach(() => vi.clearAllMocks());

  test("reads current, merges changes, posts full body", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        vehicleId: 70,
        asiakasId: 1349,
        vehicleNimi: "Old",
        vehicleRegNo: "OLD-1",
        vehicleTypeId: 1,
        vehiclePuomi: 28,
        memo: "m",
        showInGrid: true,
        hasGpsTracking: false,
        vehicleM3: 7,
        defaultKuski_personId: null,
        sortNo: 3,
        showInReports: true,
        useNoDriverBar: false,
        tuoteId: null,
        isRestricted: false,
        multiTenantVisibility: false,
        defaultVisibilityAsiakasIds: null,
        firstDate: null,
        lastDate: null,
        vehicleNo: 5,
      },
    ]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      vehicleId: 70,
    });
    await runVehicleUpdate(
      c,
      70,
      { vehicleRegNo: "NEW-9", vehicleM3: 9 },
      { reason: "rebrand" }
    );
    expect(c.get).toHaveBeenCalledWith("/api/vehicle/get/70");
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/save",
      expect.objectContaining({
        vehicleId: 70,
        vehicleRegNo: "NEW-9",
        vehicleM3: 9,
        vehicleNimi: "Old",
        vehicleTypeId: 1,
      }),
      { headers: { "X-Action-Reason": "rebrand" } }
    );
  });

  test("throws 404 CliError when vehicle absent", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    await expect(
      runVehicleUpdate(c, 999, { memo: "x" }, {})
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});

describe("ib vehicle dates", () => {
  const c = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  beforeEach(() => (c.get as ReturnType<typeof vi.fn>).mockReset());
  test("list hits /dates/:id", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleDatesList(c, 7);
    expect(c.get).toHaveBeenCalledWith("/api/cli/vehicle/dates/7");
  });
  test("expiring without days hits bare path", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleDatesExpiring(c);
    expect(c.get).toHaveBeenCalledWith("/api/cli/vehicle/dates/expiring");
  });
  test("expiring with days appends ?days=", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleDatesExpiring(c, 60);
    expect(c.get).toHaveBeenCalledWith("/api/cli/vehicle/dates/expiring?days=60");
  });
});

describe("runVehicleDriversAssign", () => {
  const c = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: vi.fn(),
  } as unknown as ApiClient;
  beforeEach(() => vi.clearAllMocks());
  test("posts {vehicleId,personId,yyyymmdd} with write headers", async () => {
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
    await runVehicleDriversAssign(c, 7, 555, "2026-06-02", { reason: "shift" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/driverDays/save",
      { vehicleId: 7, personId: 555, yyyymmdd: 20260602 },
      { headers: { "X-Action-Reason": "shift" } }
    );
  });
});
