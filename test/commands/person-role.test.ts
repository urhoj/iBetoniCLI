import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runPersonRoleList,
  runPersonRoleGrant,
  runPersonRoleRevoke,
  runPersonRoleSetDates,
  roleDatesFromFlags,
} from "../../src/commands/person/index.js";
import { todayHelsinki } from "../../src/dates.js";

const mockClient = mockApiClient();

/** Unsigned JWT whose payload carries only ownerAsiakasId — what resolveActiveOwnerAsiakasId reads. */
function tokenFor(ownerAsiakasId: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ ownerAsiakasId })}.sig`;
}

describe("runPersonRoleList", () => {
  beforeEach(() => { mockClient.get.mockReset(); });

  test("GETs /api/asiakasPersonSettings/get/<asiakasId>/<personId> and resolves role names", async () => {
    mockClient.get.mockResolvedValueOnce([
      { asiakasPersonSettingId: 501, asiakasPersonSettingTypeId: 11 },
      { asiakasPersonSettingId: 502, asiakasPersonSettingTypeId: 9999 },
    ]);
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakasPersonSettings/get/26/5351");
    expect(result.items).toEqual([
      { asiakasPersonSettingId: 501, roleTypeId: 11, role: "keikkaHandler", asiakasId: 26, startDate: null, endDate: null, active: true },
      { asiakasPersonSettingId: 502, roleTypeId: 9999, role: null, asiakasId: 26, startDate: null, endDate: null, active: true },
    ]);
    expect(result.count).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  test("defensively unwraps an mssql { recordset } wrapper", async () => {
    mockClient.get.mockResolvedValueOnce({
      recordset: [{ asiakasPersonSettingId: 503, asiakasPersonSettingTypeId: 8 }],
    });
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(result.items[0]).toEqual({ asiakasPersonSettingId: 503, roleTypeId: 8, role: "pumppari", asiakasId: 26, startDate: null, endDate: null, active: true });
  });

  // fb#2887: the view lists expired roles too, so each item carries its dates,
  // the company it belongs to, and whether it is valid right now.
  test("carries asiakasId + start/end dates and an active flag (expired and future roles are inactive)", async () => {
    mockClient.get.mockResolvedValueOnce([
      { asiakasPersonSettingId: 1, asiakasPersonSettingTypeId: 2, startDate: "2020-01-01T00:00:00.000Z", endDate: null },
      { asiakasPersonSettingId: 2, asiakasPersonSettingTypeId: 2, startDate: "2020-01-01T00:00:00.000Z", endDate: "2021-01-01T00:00:00.000Z" },
      { asiakasPersonSettingId: 3, asiakasPersonSettingTypeId: 2, startDate: "2999-01-01T00:00:00.000Z", endDate: null },
    ]);
    const { items } = await runPersonRoleList(mockClient, 6291, 27);
    expect(items.map((i) => [i.asiakasId, i.active])).toEqual([[27, true], [27, false], [27, false]]);
    expect(items[1]).toMatchObject({ startDate: "2020-01-01T00:00:00.000Z", endDate: "2021-01-01T00:00:00.000Z" });
  });

  test("returns an empty envelope when the person has no roles", async () => {
    mockClient.get.mockResolvedValueOnce([]);
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });

  // fb#1783 / fb#1770: `--company 27` alone used to exit 4 "missing required
  // flag: --asiakas". The acting company (the switch JWT --company mints, else
  // the session's active company) is the default target; --asiakas overrides.
  test("defaults asiakasId to the acting company from the token when --asiakas is omitted", async () => {
    mockClient.getCurrentToken.mockReturnValue(tokenFor(27));
    mockClient.get.mockResolvedValueOnce([{ asiakasPersonSettingId: 9, asiakasPersonSettingTypeId: 8 }]);
    const result = await runPersonRoleList(mockClient, 316);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakasPersonSettings/get/27/316");
    expect(result.items[0]).toEqual({ asiakasPersonSettingId: 9, roleTypeId: 8, role: "pumppari", asiakasId: 27, startDate: null, endDate: null, active: true });
  });

  test("an explicit --asiakas still wins over the acting company", async () => {
    mockClient.getCurrentToken.mockReturnValue(tokenFor(27));
    mockClient.get.mockResolvedValueOnce([]);
    await runPersonRoleList(mockClient, 316, 26);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakasPersonSettings/get/26/316");
  });
});

describe("runPersonRoleGrant", () => {
  beforeEach(() => { mockClient.post.mockReset(); });

  test("POSTs add/<asiakasId>/<personId>/<roleTypeId> and projects raw success to { granted }", async () => {
    // Real write returns bare/raw backend success (feedback #16: was useless `null`).
    mockClient.post.mockResolvedValueOnce(null);
    const out = await runPersonRoleGrant(mockClient, 5351, 26, 11, { reason: "onboard driver" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/add/26/5351/11",
      {},
      { headers: { "X-Action-Reason": "onboard driver" } }
    );
    expect(out).toEqual({ granted: { personId: 5351, asiakasId: 26, roleTypeId: 11 } });
  });

  test("forwards --dry-run header and passes the dry-run preview through", async () => {
    mockClient.post.mockResolvedValueOnce({
      dryRun: true,
      wouldCreate: { personId: 5351, asiakasId: 26, personSettingTypeId: 11 },
    });
    const out = await runPersonRoleGrant(mockClient, 5351, 26, 11, { reason: "x", dryRun: true });
    const call = mockClient.post.mock.calls[0];
    expect(call[2].headers["X-Dry-Run"]).toBe("1");
    expect(out).toEqual({
      dryRun: true,
      wouldCreate: { personId: 5351, asiakasId: 26, personSettingTypeId: 11 },
    });
  });
});

describe("runPersonRoleRevoke", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.delete.mockReset();
  });

  test("DELETEs the by-role path in one request; returns the backend envelope", async () => {
    mockClient.delete.mockResolvedValueOnce({ removed: 1, asiakasPersonSettingId: 501 });
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "rotation" });
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/byRole/26/5351/11",
      { headers: { "X-Action-Reason": "rotation" } }
    );
    expect(result).toMatchObject({ removed: 1 });
  });

  /**
   * fb#1537 — the regression that motivated the rewrite. The old implementation
   * GET the role list first and returned { removed: 0 } when it saw no match.
   * That GET is a CACHED route, so a stale cache reported a revocation that
   * never happened, with exit 0. Asserting that NO read precedes the delete is
   * the whole contract: the client must not decide "absent" from a cached read,
   * because it cannot tell a missing role from a missing cache entry.
   */
  test("never reads before deleting — a cached list must not be able to veto a revoke", async () => {
    mockClient.delete.mockResolvedValueOnce({ removed: 1, asiakasPersonSettingId: 501 });
    await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "rotation" });
    expect(mockClient.get).not.toHaveBeenCalled();
  });

  test("idempotent { removed: 0 } now comes from the SERVER, not a client-side skip", async () => {
    mockClient.delete.mockResolvedValueOnce({ removed: 0 });
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "rotation" });
    // The request is still made — that is the point. The server resolves the row
    // uncached and answers authoritatively.
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/byRole/26/5351/11",
      { headers: { "X-Action-Reason": "rotation" } }
    );
    expect(result).toEqual({ removed: 0 });
  });

  test("under --dry-run returns the backend wouldDelete envelope", async () => {
    mockClient.delete.mockResolvedValueOnce({
      dryRun: true, wouldDelete: { asiakasPersonSettingId: 501 }, validation: { ok: true },
    });
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "x", dryRun: true });
    const call = mockClient.delete.mock.calls[0];
    expect(call[1].headers["X-Dry-Run"]).toBe("1");
    expect(result).toMatchObject({ dryRun: true });
  });
});

// fb#2935: end-date a role instead of deleting it.
describe("runPersonRoleSetDates", () => {
  beforeEach(() => { mockClient.get.mockReset(); mockClient.put.mockReset(); });

  test("PUTs only the given dates to the by-role dates path, with no read first", async () => {
    mockClient.put.mockResolvedValueOnce({ updated: 1, asiakasPersonSettingId: 501 });
    const result = await runPersonRoleSetDates(mockClient, 5351, 8, 11, { endDate: "2026-10-28" }, { reason: "moved" });
    expect(mockClient.put).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/byRole/8/5351/11/dates",
      { endDate: "2026-10-28" },
      { headers: { "X-Action-Reason": "moved" } }
    );
    expect(mockClient.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1 });
  });

  test("forwards X-Dry-Run and passes the wouldUpdate preview through", async () => {
    mockClient.put.mockResolvedValueOnce({ dryRun: true, wouldUpdate: { asiakasPersonSettingId: 501 } });
    const result = await runPersonRoleSetDates(mockClient, 5351, 8, 11, { endDate: "2026-10-28" }, { dryRun: true });
    expect(mockClient.put.mock.calls[0][2].headers["X-Dry-Run"]).toBe("1");
    expect(result).toMatchObject({ dryRun: true });
  });
});

describe("roleDatesFromFlags", () => {
  test("end sends only endDate (so startDate is kept), defaulting to today", () => {
    expect(roleDatesFromFlags("end", {})).toEqual({ endDate: todayHelsinki() });
    expect(roleDatesFromFlags("end", { date: "2026-10-31" })).toEqual({ endDate: "2026-10-31" });
  });

  test("set-dates sends only the flags given; an empty string clears to null", () => {
    expect(roleDatesFromFlags("set-dates", { start: "2026-11-01" })).toEqual({ startDate: "2026-11-01" });
    expect(roleDatesFromFlags("set-dates", { end: "" })).toEqual({ endDate: null });
  });

  test("set-dates with neither flag exits 4", () => {
    expect(() => roleDatesFromFlags("set-dates", {})).toThrow(/--start and\/or --end/);
  });
});
