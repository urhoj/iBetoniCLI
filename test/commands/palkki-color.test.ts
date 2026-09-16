import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPalkkiColorList,
  runPalkkiColorGet,
  runPalkkiColorCreate,
  runPalkkiColorUpdate,
  runPalkkiColorDelete,
  runPalkkiColorReorder,
  buildPalkkiColorBody,
  resolvePalkkiColorCreateBody,
  type PalkkiColorRow,
} from "../../src/commands/palkki/index.js";

const mockClient = mockApiClient();

/** Build a minimal unsigned JWT (header.body.sig) with the given payload. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

const ROW = (over: Partial<PalkkiColorRow> = {}): PalkkiColorRow => ({
  barColorId: 12,
  title: "Myöhässä",
  ehto: "keikka.late",
  style: 'backgroundColor: "#f44336",',
  comment: null,
  sortNo: 120,
  ownerAsiakasId: 10,
  isActive: true,
  iconName: "warning",
  iconColor: "#000",
  iconBackgroundColor: "#ccc",
  ...over,
});

describe("buildPalkkiColorBody / resolvePalkkiColorCreateBody", () => {
  test("buildPalkkiColorBody: typed flags map to backend body keys and win over --body", () => {
    const body = buildPalkkiColorBody(
      { title: "from-body", extra: "kept" },
      {
        title: "Myöhässä",
        ehto: "keikka.late",
        style: 'backgroundColor: "#f44336",',
        comment: "note",
        sortNo: 120,
        owner: 27,
        active: false,
        iconName: "warning",
        iconText: "BV",
        iconColor: "#000",
        iconBackgroundColor: "#ccc",
      }
    );
    expect(body).toEqual({
      extra: "kept",
      title: "Myöhässä",
      ehto: "keikka.late",
      style: 'backgroundColor: "#f44336",',
      comment: "note",
      sortNo: 120,
      ownerAsiakasId: 27,
      isActive: false,
      iconName: "warning",
      iconText: "BV",
      iconColor: "#000",
      iconBackgroundColor: "#ccc",
    });
  });

  test("buildPalkkiColorBody: --icon-text '' clears the letters (sent as empty, backend stores NULL)", () => {
    expect(buildPalkkiColorBody({}, { iconText: "" })).toEqual({ iconText: "" });
  });

  test("buildPalkkiColorBody: an absent typed field leaves the --body value untouched", () => {
    const body = buildPalkkiColorBody({ title: "from-body", ownerAsiakasId: 8 }, {});
    expect(body).toEqual({ title: "from-body", ownerAsiakasId: 8 });
  });

  describe("resolvePalkkiColorCreateBody (mirrors fb#1659's resolvePalkkiTypeCreateBody)", () => {
    beforeEach(() => {
      mockClient.getCurrentToken.mockReset();
      mockClient.get.mockReset();
    });

    test("an explicit --body ownerAsiakasId survives when --owner is omitted", async () => {
      const body = await resolvePalkkiColorCreateBody(mockClient, { title: "x", ownerAsiakasId: 27 }, {});
      expect(body.ownerAsiakasId).toBe(27);
      expect(mockClient.getCurrentToken).not.toHaveBeenCalled();
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    test("neither --owner nor --body ownerAsiakasId given -> defaults to the active company", async () => {
      mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 8 }));
      const body = await resolvePalkkiColorCreateBody(mockClient, { title: "x" }, {});
      expect(body.ownerAsiakasId).toBe(8);
    });
  });
});

describe("ib palkki color list / get", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReset();
  });

  test("list hits GET /api/grid/barColors/list/:owner and wraps the bare array into a list envelope", async () => {
    mockClient.get.mockResolvedValueOnce([ROW()]);
    const result = await runPalkkiColorList(mockClient, { owner: 27 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/27");
    expect(result).toEqual({ items: [ROW()], nextCursor: null, count: 1 });
  });

  test("list defaults owner to the active company when --owner is omitted", async () => {
    mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 8 }));
    mockClient.get.mockResolvedValueOnce([]);
    await runPalkkiColorList(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/8");
  });

  test("get filters the owner's list client-side for the matching id", async () => {
    mockClient.get.mockResolvedValueOnce([ROW({ barColorId: 1 }), ROW({ barColorId: 12 })]);
    const row = await runPalkkiColorGet(mockClient, 12, { owner: 27 });
    expect(row.barColorId).toBe(12);
  });

  test("get exits 5 locally when the id is not in the resolved owner's list — no separate request beyond the list call", async () => {
    mockClient.get.mockResolvedValueOnce([ROW({ barColorId: 1 })]);
    await expect(runPalkkiColorGet(mockClient, 999, { owner: 27 })).rejects.toMatchObject({ exitCode: 5 });
    expect(mockClient.get).toHaveBeenCalledTimes(1);
  });
});

describe("ib palkki color create", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("posts to /api/grid/barColors/save with no barColorId, all three write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({ barColorId: 51 });
    const body = { title: "Myöhässä", ownerAsiakasId: 27 };
    const result = await runPalkkiColorCreate(mockClient, body, {
      idempotencyKey: "create-myohassa",
      reason: "pilot rule",
    });
    expect(mockClient.post).toHaveBeenCalledWith("/api/grid/barColors/save", body, {
      headers: { "Idempotency-Key": "create-myohassa", "X-Action-Reason": "pilot rule" },
    });
    expect((result as { barColorId: number }).barColorId).toBe(51);
  });

  test("fails client-side (exit 4) when title is missing, no POST issued", async () => {
    await expect(runPalkkiColorCreate(mockClient, { ownerAsiakasId: 27 }, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("--dry-run never sends the request — resolves locally to a wouldCreate preview", async () => {
    const body = { title: "Testi", ownerAsiakasId: 27 };
    const result = await runPalkkiColorCreate(mockClient, body, { dryRun: true });
    expect(result).toEqual({ dryRun: true, wouldCreate: body });
    expect(mockClient.post).not.toHaveBeenCalled();
  });
});

describe("ib palkki color update", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReset();
  });

  test("posts the partial body plus barColorId to /save, live path", async () => {
    mockClient.post.mockResolvedValueOnce({ barColorId: 12 });
    await runPalkkiColorUpdate(mockClient, 12, { title: "y" }, { reason: "r" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/grid/barColors/save",
      { title: "y", barColorId: 12 },
      { headers: { "X-Action-Reason": "r" } }
    );
  });

  test("empty body exits 4 without a POST", async () => {
    await expect(runPalkkiColorUpdate(mockClient, 12, {}, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("--dry-run never POSTs — looks the row up (active company) and previews the merge", async () => {
    mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 10 }));
    mockClient.get.mockResolvedValueOnce([ROW()]);
    const result = await runPalkkiColorUpdate(mockClient, 12, { title: "y" }, { dryRun: true });
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/10");
    expect(result).toEqual({ dryRun: true, wouldUpdate: { ...ROW(), title: "y", barColorId: 12 } });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("--dry-run on a missing row exits 5 locally, no POST", async () => {
    mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 10 }));
    mockClient.get.mockResolvedValueOnce([]);
    await expect(runPalkkiColorUpdate(mockClient, 999, { title: "y" }, { dryRun: true })).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(mockClient.post).not.toHaveBeenCalled();
  });
});

describe("ib palkki color delete", () => {
  beforeEach(() => {
    mockClient.delete.mockReset();
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReset();
  });

  test("hits DELETE /api/grid/barColors/delete/:id, live path", async () => {
    mockClient.delete.mockResolvedValueOnce({ success: true });
    await runPalkkiColorDelete(mockClient, 12, { reason: "duplicate" });
    expect(mockClient.delete).toHaveBeenCalledWith("/api/grid/barColors/delete/12", {
      headers: { "X-Action-Reason": "duplicate" },
    });
  });

  test("--dry-run never DELETEs — looks the row up first and previews", async () => {
    mockClient.get.mockResolvedValueOnce([ROW()]);
    const result = await runPalkkiColorDelete(mockClient, 12, { dryRun: true }, { owner: 27 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/27");
    expect(result).toEqual({ dryRun: true, wouldDelete: { barColorId: 12 } });
    expect(mockClient.delete).not.toHaveBeenCalled();
  });

  test("--dry-run on a missing row exits 5 locally, no DELETE", async () => {
    mockClient.get.mockResolvedValueOnce([]);
    await expect(
      runPalkkiColorDelete(mockClient, 999, { dryRun: true }, { owner: 27 })
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(mockClient.delete).not.toHaveBeenCalled();
  });
});

describe("ib palkki color reorder", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
    mockClient.get.mockReset();
    mockClient.getCurrentToken.mockReset();
  });

  test("resolves both rows' current sortNo under the shared owner and posts the SWAPPED values", async () => {
    mockClient.get.mockResolvedValue([ROW({ barColorId: 1, sortNo: 5 }), ROW({ barColorId: 2, sortNo: 9 })]);
    mockClient.post.mockResolvedValueOnce({ success: true });
    await runPalkkiColorReorder(mockClient, 1, 2, {}, { owner: 27 });
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/27");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/grid/barColors/reorder",
      { barColorId1: 1, sortNo1: 9, barColorId2: 2, sortNo2: 5 },
      { headers: {} }
    );
  });

  test("either id missing from the resolved owner's list exits 5 locally, no POST", async () => {
    mockClient.get.mockResolvedValue([ROW({ barColorId: 1, sortNo: 5 })]);
    await expect(runPalkkiColorReorder(mockClient, 1, 999, {}, { owner: 27 })).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("--dry-run resolves the same lookup and previews the swap without posting", async () => {
    mockClient.get.mockResolvedValue([ROW({ barColorId: 1, sortNo: 5 }), ROW({ barColorId: 2, sortNo: 9 })]);
    const result = await runPalkkiColorReorder(mockClient, 1, 2, { dryRun: true }, { owner: 27 });
    expect(result).toEqual({
      dryRun: true,
      wouldReorder: { barColorId1: 1, sortNo1: 9, barColorId2: 2, sortNo2: 5 },
    });
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("defaults owner to the active company when --owner is omitted", async () => {
    mockClient.getCurrentToken.mockReturnValue(jwt({ ownerAsiakasId: 10 }));
    mockClient.get.mockResolvedValue([ROW({ barColorId: 1, sortNo: 5 }), ROW({ barColorId: 2, sortNo: 9 })]);
    mockClient.post.mockResolvedValueOnce({ success: true });
    await runPalkkiColorReorder(mockClient, 1, 2, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/grid/barColors/list/10");
  });
});
