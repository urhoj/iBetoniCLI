import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runKeikkaCreate,
  runKeikkaUpdate,
  runKeikkaDriversAssign,
} from "../../src/commands/keikka/index.js";

const mockClient = mockApiClient();

describe("ib keikka create/update/drivers", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runKeikkaCreate forwards body + all three write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({
      keikkaId: 12345,
    });
    const body = { pvm: "2026-06-15", asiakasId: 1349, vehicleId: 7 };
    const result = await runKeikkaCreate(mockClient, body, {
      dryRun: true,
      idempotencyKey: "create-2026-06-15",
      reason: "scheduled via cron job",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/keikka/newKeikka",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "create-2026-06-15",
          "X-Action-Reason": "scheduled via cron job",
        },
      }
    );
    expect((result as { keikkaId: number }).keikkaId).toBe(12345);
  });

  test("runKeikkaUpdate posts numeric keikkaTilaId to /tila/set (NOT /setStatus); guards bad input", async () => {
    mockClient.post.mockResolvedValueOnce({
      success: true,
    });
    await runKeikkaUpdate(mockClient, 9001, { status: "9" }, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/keikka/tila/set",
      { keikkaId: 9001, keikkaTilaId: 9 },
      { headers: {} }
    );

    // Non-status field set without status → v1.0 guard rejects.
    await expect(
      runKeikkaUpdate(mockClient, 9001, { vehicleId: 7 }, {})
    ).rejects.toThrow(/v1\.0 only supports --status/);

    // Non-numeric status → exit-4 validation error (failWith), no POST.
    mockClient.post.mockClear();
    await expect(
      runKeikkaUpdate(mockClient, 9001, { status: "done" }, {})
    ).rejects.toThrow(/numeric keikkaTilaId/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("runKeikkaDriversAssign posts empty body to /defaultDriver/assign/:id", async () => {
    mockClient.post.mockResolvedValueOnce({
      assigned: true,
    });
    await runKeikkaDriversAssign(mockClient, 9001, {
      idempotencyKey: "assign-9001",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/keikka/defaultDriver/assign/9001",
      {},
      { headers: { "Idempotency-Key": "assign-9001" } }
    );
  });
});
