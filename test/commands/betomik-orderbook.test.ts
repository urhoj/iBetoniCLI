import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runBetomikOrderbookImport,
  runBetomikOrderbookRuns,
  runBetomikOrderbookRows,
  runBetomikOrderbookReview,
  runBetomikOrderbookPropose,
  runBetomikOrderbookAiStats,
} from "../../src/commands/betomikOrderbook/index.js";

const mockClient = mockApiClient();

describe("ib dev betomik-orderbook import", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runBetomikOrderbookImport forwards the body verbatim + all three write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({ importRunId: 42, rowCount: 3 });
    const body = {
      sheetLabel: "KAIKKI 40 / 2026",
      isoYear: 2026,
      isoWeek: 40,
      rows: [{ driver_name: "Kaitsu" }, { driver_name: "Soini" }, { driver_name: "Heiti" }],
    };
    const result = await runBetomikOrderbookImport(mockClient, body, {
      dryRun: true,
      idempotencyKey: "week-40-import",
      reason: "manual weekly import",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/import",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "week-40-import",
          "X-Action-Reason": "manual weekly import",
        },
      }
    );
    expect((result as { importRunId: number }).importRunId).toBe(42);
  });
});

describe("ib dev betomik-orderbook runs / rows", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("runs: GET /api/betomik-orderbook/runs, unwraps {items} into a ListEnvelope", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [{ importRunId: 1, sheetLabel: "KAIKKI 37 / 2026", isoYear: 2026, isoWeek: 37, rowCount: 176 }],
    });
    const result = await runBetomikOrderbookRuns(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs");
    expect(result).toEqual({
      items: [{ importRunId: 1, sheetLabel: "KAIKKI 37 / 2026", isoYear: 2026, isoWeek: 37, rowCount: 176 }],
      nextCursor: null,
      count: 1,
    });
  });

  test("runs: a non-envelope body yields an empty envelope, never a throw", async () => {
    mockClient.get.mockResolvedValueOnce(null);
    const result = await runBetomikOrderbookRuns(mockClient);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("rows: GET /api/betomik-orderbook/runs/:runId/rows with the parsed id", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [{ plate: "GNG-544", m3: 12.5, sourceType: "betomik_self" }] });
    const result = await runBetomikOrderbookRows(mockClient, 7);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/7/rows");
    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({ plate: "GNG-544", m3: 12.5 });
  });
});

describe("ib dev betomik-orderbook review / propose / ai-stats", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
    mockClient.get.mockReset();
  });

  test("review: POST /rows/:rowId/review with the override body + write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({ updated: true });
    const result = await runBetomikOrderbookReview(
      mockClient,
      143,
      { status: "approved", rowKind: "palkki", palkkiType: "pois ajosta" },
      { reason: "Halli-rivi", dryRun: true }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/rows/143/review",
      { status: "approved", rowKind: "palkki", palkkiType: "pois ajosta" },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "Halli-rivi" } }
    );
    expect(result).toEqual({ updated: true });
  });

  test("propose: POST /runs/:runId/propose with provider/force + headers", async () => {
    mockClient.post.mockResolvedValueOnce({ runId: 1, proposed: 175, failed: 1 });
    await runBetomikOrderbookPropose(mockClient, 1, { provider: "local", force: true }, { reason: "bake-off" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/runs/1/propose",
      { provider: "local", force: true },
      { headers: { "X-Action-Reason": "bake-off" } }
    );
  });

  test("ai-stats: GET /runs/:runId/ai-stats, body returned as-is", async () => {
    mockClient.get.mockResolvedValueOnce({ runId: 1, scored: 3, humanAgreement: { rowKind: { n: 3, agree: 3, rate: 1 } } });
    const result = await runBetomikOrderbookAiStats(mockClient, 1);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/1/ai-stats");
    expect((result as { scored: number }).scored).toBe(3);
  });
});
