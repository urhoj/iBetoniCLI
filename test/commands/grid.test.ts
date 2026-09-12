import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPalkkiTypeCreate,
  buildPalkkiTypeCreateBody,
  resolvePalkkiTypeCreateBody,
} from "../../src/commands/grid/index.js";

const mockClient = mockApiClient();

/** Build a minimal unsigned JWT (header.body.sig) with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

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

  describe("resolvePalkkiTypeCreateBody (fb#1659 regression)", () => {
    beforeEach(() => {
      mockClient.getCurrentToken.mockReset();
      mockClient.get.mockReset();
    });

    test("an explicit --body ownerAsiakasId survives when --owner is omitted (was clobbered pre-fix)", async () => {
      const body = await resolvePalkkiTypeCreateBody(
        mockClient,
        { name: "HUOM", ownerAsiakasId: 27 },
        { owner: undefined }
      );
      expect(body.ownerAsiakasId).toBe(27);
      // The whole point of the fix: no active-company lookup should even run
      // when the merged body already has an owner.
      expect(mockClient.getCurrentToken).not.toHaveBeenCalled();
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    test("an explicit --owner still wins over a --body ownerAsiakasId (typed flags win, unchanged)", async () => {
      const body = await resolvePalkkiTypeCreateBody(
        mockClient,
        { name: "HUOM", ownerAsiakasId: 27 },
        { owner: 8 }
      );
      expect(body.ownerAsiakasId).toBe(8);
      expect(mockClient.getCurrentToken).not.toHaveBeenCalled();
    });

    test("neither --owner nor --body ownerAsiakasId given -> defaults to the active company", async () => {
      mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 8 }));
      const body = await resolvePalkkiTypeCreateBody(
        mockClient,
        { name: "HUOM" },
        { owner: undefined }
      );
      expect(body.ownerAsiakasId).toBe(8);
    });
  });
});
