import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPalkkiTypeCreate,
  buildPalkkiTypeCreateBody,
} from "../../src/commands/grid/index.js";

const mockClient = mockApiClient();

describe("ib grid palkki-type create", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runPalkkiTypeCreate posts to /api/grid/palkkiType/new with all three write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({
      success: true,
      rowsAffected: 1,
      palkkiType: { grid_palkkiTypeId: 51 },
    });
    const body = { name: "betonitoimitus", ownerAsiakasId: 27 };
    const result = await runPalkkiTypeCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-betonitoimitus",
      reason: "replicate Kalle Urho Oy palkki types",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/grid/palkkiType/new",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-betonitoimitus",
          "X-Action-Reason": "replicate Kalle Urho Oy palkki types",
        },
      }
    );
    expect(
      (result as { palkkiType: { grid_palkkiTypeId: number } }).palkkiType
        .grid_palkkiTypeId
    ).toBe(51);
  });

  test("runPalkkiTypeCreate fails client-side (exit 4) when name is missing, no POST issued", async () => {
    await expect(
      runPalkkiTypeCreate(mockClient, { ownerAsiakasId: 27 }, {})
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("buildPalkkiTypeCreateBody: typed flags map to the backend body shape and win over --body", () => {
    const body = buildPalkkiTypeCreateBody(
      { name: "from-body", extra: "kept" },
      {
        name: "työmääräys",
        description: "työmääräys",
        owner: 27,
        active: true,
        vehicleAvailable: true,
        sortNo: 110,
        showReportKlo: true,
        reportStyle: 'marginLeft: "5px",\nfontWeight: "bold",',
        showInReport: true,
        isInventoryTransfer: false,
        isJob: true,
      }
    );
    expect(body).toEqual({
      extra: "kept",
      name: "työmääräys",
      unit: "työmääräys",
      ownerAsiakasId: 27,
      isActive: true,
      vehicleAvailable: true,
      sortNo: 110,
      showReportKlo: true,
      reportStyle: 'marginLeft: "5px",\nfontWeight: "bold",',
      showInReport: true,
      isInventoryTransfer: false,
      isJob: true,
    });
  });

  test("buildPalkkiTypeCreateBody: an absent typed field leaves the --body value untouched", () => {
    const body = buildPalkkiTypeCreateBody(
      { name: "from-body", ownerAsiakasId: 8 },
      {}
    );
    expect(body).toEqual({ name: "from-body", ownerAsiakasId: 8 });
  });
});
