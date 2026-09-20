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

    // No known field at all → exit 4, no POST.
    await expect(
      runKeikkaUpdate(mockClient, 9001, {}, {})
    ).rejects.toThrow(/nothing to update/i);

    // Non-numeric status → exit-4 validation error (failWith), no POST.
    mockClient.post.mockClear();
    await expect(
      runKeikkaUpdate(mockClient, 9001, { status: "done" }, {})
    ).rejects.toThrow(/numeric keikkaTilaId/);
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("runKeikkaUpdate with --status AND a move flag → exit 4 before any POST (two routes, no atomicity)", async () => {
    await expect(
      runKeikkaUpdate(mockClient, 9001, { status: "9", vehicle: 54 }, {})
    ).rejects.toThrow(expect.objectContaining({ exitCode: 4 }));
    expect(mockClient.post).not.toHaveBeenCalled();
  });

  test("runKeikkaUpdate --vehicle alone posts {vehicleId} to /api/cli/keikka/move/:id without reading the row", async () => {
    mockClient.post.mockResolvedValueOnce({ keikkaId: 9001, vehicleChanged: true });
    await runKeikkaUpdate(mockClient, 9001, { vehicle: 54 }, { dryRun: true });
    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/move/9001",
      { vehicleId: 54 },
      { headers: { "X-Dry-Run": "1" } }
    );
  });

  test("runKeikkaUpdate time flags read pvm/time from `get` and compose Helsinki instants + kesto", async () => {
    mockClient.get.mockResolvedValueOnce({ keikkaId: 9001, pvm: "2026-09-21", time: "08:00" });
    mockClient.post.mockResolvedValueOnce({ ok: true });
    // --date alone keeps 08:00; --end derives kesto from the (unchanged) start.
    await runKeikkaUpdate(mockClient, 9001, { date: "2026-09-22", end: "10:30" }, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/cli/keikka/get/9001");
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/cli/keikka/move/9001",
      { pumppuAika: "2026-09-22T05:00:00.000Z", pumppuKesto: 150 },
      { headers: {} }
    );
  });

  test("runKeikkaUpdate --end before --start → exit 4; keikka without pumppuAika needs both --date and --start", async () => {
    mockClient.get.mockResolvedValue({ keikkaId: 9001, pvm: "2026-09-21", time: "08:00" });
    await expect(
      runKeikkaUpdate(mockClient, 9001, { end: "07:00" }, {})
    ).rejects.toThrow(expect.objectContaining({ exitCode: 4 }));
    mockClient.get.mockResolvedValue({ keikkaId: 9001, pvm: null, time: null });
    await expect(
      runKeikkaUpdate(mockClient, 9001, { start: "09:00" }, {})
    ).rejects.toThrow(/--date and --start/);
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
