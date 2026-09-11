import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runBetomikOrderbookImport } from "../../src/commands/betomikOrderbook/index.js";

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
