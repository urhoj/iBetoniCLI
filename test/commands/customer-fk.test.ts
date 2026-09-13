import { describe, test, expect } from "vitest";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import { runCustomerFkList, runCustomerFkRemove, runCustomerFkSet } from "../../src/commands/customer/fk.js";

const SOURCES = [
  { foreignKeySourceId: 3, foreignKeySourceName: "fennoa", foreignKeySourceColumn: "customer_id", ownerAsiakasId: 8 },
];
const ROW = {
  asiakasForeignKeyId: 55,
  foreignKey: "F-1001",
  foreignAsiakasId: 8,
  ownerAsiakasId: 8,
  entryTime: "2026-01-01T00:00:00.000Z",
  foreignKeySourceId: 3,
  foreignKeySourceName: "fennoa",
  foreignKeySourceColumn: "customer_id",
};

function client(rows: unknown[] = []): MockApiClient {
  const c = mockApiClient();
  c.get.mockImplementation(async (path: string) => (path.startsWith("/api/foreignKey/sourceList/") ? SOURCES : rows));
  c.post.mockResolvedValue({ success: true, action: "created", rowsAffected: 1 });
  c.delete.mockResolvedValue({ success: true, rowsAffected: 1 });
  return c;
}

describe("customer fk", () => {
  test("list projects the JOINed rows", async () => {
    const c = client([ROW]);
    const out = await runCustomerFkList(c, 1234, 8);
    expect(c.get).toHaveBeenCalledWith("/api/foreignKey/customer/1234/8");
    expect(out).toEqual({
      items: [{ asiakasForeignKeyId: 55, key: "F-1001", source: "fennoa", sourceId: 3, entryTime: ROW.entryTime }],
      nextCursor: null,
      count: 1,
      truncated: false,
    });
  });

  test("set posts the upsert body and maps the plan; exact key match is unchanged (no POST)", async () => {
    const c = client([]);
    const out = await runCustomerFkSet(c, 1234, { source: "fennoa", key: "F-1001", owner: 8 }, { reason: "sync" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/foreignKey/customer",
      { asiakasId: 1234, foreignKeySourceId: 3, foreignKey: "F-1001", ownerAsiakasId: 8 },
      { headers: { "X-Action-Reason": "sync" } }
    );
    expect(out).toEqual({ asiakasId: 1234, ownerAsiakasId: 8, source: "fennoa", sourceId: 3, key: "F-1001", action: "inserted" });

    const c2 = client([ROW]);
    expect(await runCustomerFkSet(c2, 1234, { source: "3", key: "F-1001", owner: 8 }, {})).toMatchObject({ action: "unchanged" });
    expect(c2.post).not.toHaveBeenCalled();
    expect(await runCustomerFkSet(c2, 1234, { source: "3", key: "F-2", owner: 8 }, { dryRun: true })).toEqual({
      dryRun: true,
      would: expect.objectContaining({ action: "updated", key: "F-2" }),
    });
    expect(c2.post).not.toHaveBeenCalled();
  });

  test("a 200 {success:false} body becomes exit 6", async () => {
    const c = client([]);
    c.post.mockResolvedValue({ success: false, error: "Violation of UNIQUE KEY constraint" });
    await expect(runCustomerFkSet(c, 1234, { source: "fennoa", key: "dup", owner: 8 }, {})).rejects.toMatchObject({
      exitCode: 6,
      message: expect.stringContaining("UNIQUE"),
    });
  });

  test("remove verifies the id on the customer, then DELETEs owner-scoped", async () => {
    const c = client([ROW]);
    await expect(runCustomerFkRemove(c, 1234, "56", { owner: 8 }, {})).rejects.toMatchObject({ exitCode: 5 });
    expect(c.delete).not.toHaveBeenCalled();
    const out = await runCustomerFkRemove(c, 1234, "55", { owner: 8 }, { reason: "wrong id" });
    expect(c.delete).toHaveBeenCalledWith("/api/foreignKey/customer/55/8", { headers: { "X-Action-Reason": "wrong id" } });
    expect(out).toEqual({ action: "removed", asiakasId: 1234, ownerAsiakasId: 8, asiakasForeignKeyId: 55, key: "F-1001", source: "fennoa", sourceId: 3 });
  });
});
