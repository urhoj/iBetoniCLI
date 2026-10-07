import { describe, test, expect, beforeEach, vi } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import { runCustomerDelete } from "../../src/commands/customer/index.js";

const mockClient = mockApiClient();

/** Route the two pre-delete dependent reads (fb#2159) by path. */
function mockDependents(worksites: unknown[] = [], fks: unknown[] = []) {
  mockClient.get.mockImplementation(async (path: string) => {
    if (path === "/api/tyomaa/asiakasTyomaaList/9001") return worksites;
    if (path === "/api/foreignKey/customer/9001/1349") return fks;
    throw new Error(`unexpected GET ${path}`);
  });
}

describe("runCustomerDelete", () => {
  beforeEach(() => {
    mockClient.delete.mockReset();
    mockClient.get.mockReset();
  });

  test("DELETEs /api/asiakas/delete/<asiakasId>/<ownerAsiakasId> with X-Action-Reason", async () => {
    mockDependents();
    mockClient.delete.mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    const result = await runCustomerDelete(
      mockClient,
      9001,
      1349,
      { reason: "lifecycle cleanup" }
    );
    expect(mockClient.delete).toHaveBeenCalledWith(
      "/api/asiakas/delete/9001/1349",
      { headers: { "X-Action-Reason": "lifecycle cleanup" } }
    );
    expect(result).toEqual({
      success: true,
      rowsAffected: 1,
      leftAttached: { worksites: [], foreignKeys: [] },
    });
  });

  test("propagates --dry-run as X-Dry-Run: 1 header", async () => {
    mockDependents();
    mockClient.delete.mockResolvedValueOnce({ dryRun: true, wouldDelete: 9001 });
    await runCustomerDelete(mockClient, 9001, 1349, { reason: "test", dryRun: true });
    const call = mockClient.delete.mock.calls[0];
    expect(call[1].headers).toMatchObject({
      "X-Action-Reason": "test",
      "X-Dry-Run": "1",
    });
  });

  // fb#2159: a soft delete leaves worksites + foreign keys pointing at the row.
  test("lists the worksites and foreign keys left attached", async () => {
    mockDependents(
      [{ tyomaaId: 3602, tyomaaNimi: "Työmaa", tyomaaOsoite1: "Katu 1", tyomaaOsoite4: "Espoo" }],
      [{ asiakasForeignKeyId: 77, foreignKey: "ALIAS", foreignKeySourceName: "betomik-orderbook", foreignKeySourceId: 5, entryTime: null }]
    );
    mockClient.delete.mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    const result = (await runCustomerDelete(mockClient, 9001, 1349, { reason: "x" })) as Record<string, unknown>;
    expect(result.leftAttached).toEqual({
      worksites: [{ tyomaaId: 3602, name: "Työmaa", address: "Katu 1", city: "Espoo" }],
      foreignKeys: [{ asiakasForeignKeyId: 77, key: "ALIAS", source: "betomik-orderbook", sourceId: 5, entryTime: null }],
    });
  });

  // fb#2341: a 0-row delete used to come back as success.
  test("0 rows affected is an error (exit 5), not success", async () => {
    mockDependents();
    mockClient.delete.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    await expect(runCustomerDelete(mockClient, 9001, 1349, { reason: "x" })).rejects.toMatchObject({ exitCode: 5 });
  });

  test("a failed dependent lookup still deletes, with leftAttached: null", async () => {
    mockClient.get.mockRejectedValue(new Error("boom"));
    mockClient.delete.mockResolvedValueOnce({ success: true, rowsAffected: 1 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = (await runCustomerDelete(mockClient, 9001, 1349, { reason: "x" })) as Record<string, unknown>;
      expect(mockClient.delete).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, rowsAffected: 1, leftAttached: null });
      expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("could not list dependents");
    } finally {
      stderr.mockRestore();
    }
  });
});
