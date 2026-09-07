import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runKeikkaCreate,
  runKeikkaUpdate,
  runKeikkaDriversAssign,
  runKeikkaCopy,
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

describe("runKeikkaCopy", () => {
  const c = mockApiClient();
  const JWT =
    "e30." +
    Buffer.from(JSON.stringify({ personId: 42 })).toString("base64url") +
    ".sig";
  beforeEach(() => {
    c.post.mockReset();
    c.getCurrentToken.mockReturnValue(JWT);
  });

  test("--dry-run resolves client-side: no POST, echoes wouldCopy with the token's personId", async () => {
    const result = await runKeikkaCopy(
      c,
      9001,
      { date: "2026-09-10" },
      { dryRun: true }
    );
    expect(c.post).not.toHaveBeenCalled();
    expect(result).toEqual({
      dryRun: true,
      wouldCopy: { keikkaId: 9001, creatorPersonId: 42, newDate: "2026-09-10" },
    });
  });

  test("real call posts keikkaId + creatorPersonId + newDate and the write-flag headers", async () => {
    c.post.mockResolvedValueOnce({ returnValue: 9555 });
    const result = await runKeikkaCopy(
      c,
      9001,
      { date: "2026-09-10" },
      { reason: "repeat order" }
    );
    expect(c.post).toHaveBeenCalledWith(
      "/api/keikka/copy",
      { keikkaId: 9001, creatorPersonId: 42, newDate: "2026-09-10" },
      { headers: { "X-Action-Reason": "repeat order" } }
    );
    expect(result).toEqual({ returnValue: 9555 });
  });

  test("omits newDate entirely when no --date is given", async () => {
    c.post.mockResolvedValueOnce({ returnValue: 9556 });
    await runKeikkaCopy(c, 9001, {}, {});
    expect(c.post).toHaveBeenCalledWith(
      "/api/keikka/copy",
      { keikkaId: 9001, creatorPersonId: 42 },
      { headers: {} }
    );
  });

  test("no personId claim on the token → exit-4 failure, no POST", async () => {
    c.getCurrentToken.mockReturnValue(
      "e30." + Buffer.from(JSON.stringify({})).toString("base64url") + ".sig"
    );
    await expect(runKeikkaCopy(c, 9001, {}, {})).rejects.toThrow(
      /could not resolve personId/
    );
    expect(c.post).not.toHaveBeenCalled();
  });
});
