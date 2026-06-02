import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  runVehicleTypes,
  runVehicleSearch,
  runVehicleCreate,
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
