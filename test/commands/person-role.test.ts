import { describe, test, expect, vi, beforeEach } from "vitest";
import { runPersonRoleList, runPersonRoleGrant, runPersonRoleRevoke } from "../../src/commands/person/index.js";
import type { ApiClient } from "../../src/api/client.js";

const mockClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  getCurrentToken: vi.fn(),
} as unknown as ApiClient;

describe("runPersonRoleList", () => {
  beforeEach(() => { (mockClient.get as ReturnType<typeof vi.fn>).mockReset(); });

  test("GETs /api/asiakasPersonSettings/get/<asiakasId>/<personId> and resolves role names", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasPersonSettingId: 501, asiakasPersonSettingTypeId: 11 },
      { asiakasPersonSettingId: 502, asiakasPersonSettingTypeId: 9999 },
    ]);
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakasPersonSettings/get/26/5351");
    expect(result.items).toEqual([
      { asiakasPersonSettingId: 501, roleTypeId: 11, role: "keikkaHandler" },
      { asiakasPersonSettingId: 502, roleTypeId: 9999, role: null },
    ]);
    expect(result.count).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  test("defensively unwraps an mssql { recordset } wrapper", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      recordset: [{ asiakasPersonSettingId: 503, asiakasPersonSettingTypeId: 8 }],
    });
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(result.items[0]).toEqual({ asiakasPersonSettingId: 503, roleTypeId: 8, role: "pumppari" });
  });

  test("returns an empty envelope when the person has no roles", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const result = await runPersonRoleList(mockClient, 5351, 26);
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  });
});

describe("runPersonRoleGrant", () => {
  beforeEach(() => { (mockClient.post as ReturnType<typeof vi.fn>).mockReset(); });

  test("POSTs add/<asiakasId>/<personId>/<roleTypeId> and projects raw success to { granted }", async () => {
    // Real write returns bare/raw backend success (feedback #16: was useless `null`).
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const out = await runPersonRoleGrant(mockClient, 5351, 26, 11, { reason: "onboard driver" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/add/26/5351/11",
      {},
      { headers: { "X-Action-Reason": "onboard driver" } }
    );
    expect(out).toEqual({ granted: { personId: 5351, asiakasId: 26, roleTypeId: 11 } });
  });

  test("forwards --dry-run header and passes the dry-run preview through", async () => {
    (mockClient.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dryRun: true,
      wouldCreate: { personId: 5351, asiakasId: 26, personSettingTypeId: 11 },
    });
    const out = await runPersonRoleGrant(mockClient, 5351, 26, 11, { reason: "x", dryRun: true });
    const call = (mockClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].headers["X-Dry-Run"]).toBe("1");
    expect(out).toEqual({
      dryRun: true,
      wouldCreate: { personId: 5351, asiakasId: 26, personSettingTypeId: 11 },
    });
  });
});

describe("runPersonRoleRevoke", () => {
  beforeEach(() => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockReset();
    (mockClient.delete as ReturnType<typeof vi.fn>).mockReset();
  });

  test("looks up the setting id then DELETEs it; returns { removed: 1 }", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasPersonSettingId: 501, asiakasPersonSettingTypeId: 11 },
    ]);
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "rotation" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/asiakasPersonSettings/get/26/5351");
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakasPersonSettings/delete/501",
      { headers: { "X-Action-Reason": "rotation" } }
    );
    expect(result).toEqual({ removed: 1 });
  });

  test("is idempotent: returns { removed: 0 } and skips DELETE when role absent", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasPersonSettingId: 502, asiakasPersonSettingTypeId: 8 },
    ]);
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "rotation" });
    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: 0 });
  });

  test("under --dry-run returns the backend wouldDelete envelope", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { asiakasPersonSettingId: 501, asiakasPersonSettingTypeId: 11 },
    ]);
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      dryRun: true, wouldDelete: { asiakasPersonSettingId: 501 }, validation: { ok: true },
    });
    const result = await runPersonRoleRevoke(mockClient, 5351, 26, 11, { reason: "x", dryRun: true });
    const call = (mockClient.delete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers["X-Dry-Run"]).toBe("1");
    expect(result).toMatchObject({ dryRun: true });
  });
});
