import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleTypes,
  runVehicleSearch,
  runVehicleCreate,
  runVehicleUpdate,
  runVehicleDatesList,
  runVehicleDatesExpiring,
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

  test("runVehicleSearch appends asiakas for a cross-tenant search", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      nextCursor: null,
      count: 0,
    });
    await runVehicleSearch(mockClient, "ABC", undefined, 1380);
    expect(mockClient.get).toHaveBeenCalledWith(
      "/api/cli/vehicle/list?search=ABC&asiakas=1380"
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

  test("--asiakas rides the /new path param so the stub is owned by the target tenant (fb#94)", async () => {
    (c.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ vehicleId: 91 })
      .mockResolvedValueOnce({ vehicleId: 91 });
    await runVehicleCreate(
      c,
      { vehicleRegNo: "PUM-24", asiakasId: 1380, vehiclePuomi: 24 },
      { reason: "jerry onboarding" }
    );
    expect(c.post).toHaveBeenNthCalledWith(1, "/api/vehicle/new/1380", {}, {
      headers: { "X-Action-Reason": "jerry onboarding" },
    });
    expect(c.post).toHaveBeenNthCalledWith(
      2,
      "/api/vehicle/save",
      expect.objectContaining({
        vehicleId: 91,
        asiakasId: 1380,
        vehiclePuomi: 24,
      }),
      { headers: { "X-Action-Reason": "jerry onboarding" } }
    );
  });

  test("--asiakas dry-run also targets the tenant's /new path", async () => {
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dryRun: true,
      wouldCreate: { vehicleId: null },
    });
    await runVehicleCreate(c, { asiakasId: 1380 }, { dryRun: true });
    expect(c.post).toHaveBeenCalledWith("/api/vehicle/new/1380", {}, {
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

  const CURRENT_53 = {
    vehicleId: 53,
    asiakasId: 1349,
    vehicleNimi: "Truck",
    vehicleRegNo: "OLD-5",
    vehicleTypeId: 1,
    vehiclePuomi: 0,
    memo: null,
    showInGrid: true,
    hasGpsTracking: false,
    vehicleM3: 8,
    defaultKuski_personId: null,
    sortNo: 1,
    showInReports: true,
    useNoDriverBar: false,
    tuoteId: null,
    isRestricted: false,
    multiTenantVisibility: false,
    defaultVisibilityAsiakasIds: null,
    firstDate: null,
    lastDate: null,
    vehicleNo: 1,
  };

  test("dryRun: does not POST and returns the field-level diff", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    const out = await runVehicleUpdate(
      c,
      53,
      { vehicleM3: 9 },
      { dryRun: true, reason: "test" }
    );
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toEqual({
      dryRun: true,
      vehicleId: 53,
      wouldChange: { vehicleM3: { from: 8, to: 9 } },
    });
  });

  test("dryRun: empty diff when nothing changes (vehicleM3 '8' vs 8)", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    // String "8" must not read as a change vs the DB's numeric 8.
    const out = await runVehicleUpdate(
      c,
      53,
      { vehicleM3: "8" as unknown as number },
      { dryRun: true }
    );
    expect(out).toEqual({ dryRun: true, vehicleId: 53, wouldChange: {} });
  });

  test("dryRun: diffs showInGrid and lastDate", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    const out = await runVehicleUpdate(
      c,
      53,
      { showInGrid: false, lastDate: "2026-12-31" },
      { dryRun: true }
    );
    expect(out).toEqual({
      dryRun: true,
      vehicleId: 53,
      wouldChange: {
        showInGrid: { from: true, to: false },
        lastDate: { from: null, to: "2026-12-31" },
      },
    });
  });

  test("real write: showInGrid/lastDate land in the saved body", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ vehicleId: 53 });
    await runVehicleUpdate(
      c,
      53,
      { showInGrid: false, lastDate: "2026-12-31" },
      { reason: "retiring" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/save",
      expect.objectContaining({
        vehicleId: 53,
        showInGrid: false,
        lastDate: "2026-12-31",
      }),
      { headers: { "X-Action-Reason": "retiring" } }
    );
  });

  test("--puomi updates vehiclePuomi (merge + dry-run diff)", async () => {
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    const out = await runVehicleUpdate(
      c,
      53,
      { vehiclePuomi: 32 },
      { dryRun: true }
    );
    expect(out).toEqual({
      dryRun: true,
      vehicleId: 53,
      wouldChange: { vehiclePuomi: { from: 0, to: 32 } },
    });
    (c.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([CURRENT_53]);
    (c.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ vehicleId: 53 });
    await runVehicleUpdate(c, 53, { vehiclePuomi: 32 }, { reason: "boom fix" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/vehicle/save",
      expect.objectContaining({ vehicleId: 53, vehiclePuomi: 32 }),
      { headers: { "X-Action-Reason": "boom fix" } }
    );
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
