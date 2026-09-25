import { describe, test, expect } from "vitest";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import { runCustomerFkAdd, runCustomerFkImport, runCustomerFkList, runCustomerFkRemove, runCustomerFkSet } from "../../src/commands/customer/fk.js";

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

// fb#1975 / fb#1719: several spellings on ONE source.
const BETOMIK = { foreignKeySourceId: 50, foreignKeySourceName: "betomik-orderbook", foreignKeySourceColumn: null, ownerAsiakasId: 27 };
const alias = (id: number, key: string) => ({ ...ROW, asiakasForeignKeyId: id, foreignKey: key, foreignKeySourceId: 50, foreignKeySourceName: "betomik-orderbook" });

function aliasClient(rows: unknown[]): MockApiClient {
  const c = mockApiClient();
  c.get.mockImplementation(async (path: string) => (path.startsWith("/api/foreignKey/sourceList/") ? [...SOURCES, BETOMIK] : rows));
  c.post.mockResolvedValue({ action: "inserted", asiakasForeignKeyId: 901, heldByAsiakasId: 1496 });
  c.delete.mockResolvedValue({ success: true, rowsAffected: 1 });
  return c;
}

describe("customer fk add", () => {
  test("appends through /add (never the replacing POST) and returns the new id", async () => {
    const c = aliasClient([alias(60, "vepe")]);
    const out = await runCustomerFkAdd(c, 1496, { source: "betomik-orderbook", key: " vepe security ", owner: 27 }, { reason: "sheet" });
    expect(c.post).toHaveBeenCalledTimes(1);
    expect(c.post).toHaveBeenCalledWith(
      "/api/foreignKey/customer/add",
      { asiakasId: 1496, foreignKeySourceId: 50, foreignKey: "vepe security", ownerAsiakasId: 27 },
      { headers: { "X-Action-Reason": "sheet" } }
    );
    expect(out).toEqual({ asiakasId: 1496, ownerAsiakasId: 27, source: "betomik-orderbook", sourceId: 50, key: "vepe security", action: "inserted", asiakasForeignKeyId: 901 });
  });

  test("an existing spelling on the same source (case-insensitive) is unchanged, no POST", async () => {
    const c = aliasClient([alias(60, "vepe")]);
    expect(await runCustomerFkAdd(c, 1496, { source: "50", key: "VEPE", owner: 27 }, {})).toMatchObject({ action: "unchanged", asiakasForeignKeyId: 60, key: "vepe" });
    expect(c.post).not.toHaveBeenCalled();
  });

  test("--dry-run plans an insert without sending", async () => {
    const c = aliasClient([]);
    expect(await runCustomerFkAdd(c, 1496, { source: "betomik-orderbook", key: "vepe", owner: 27 }, { dryRun: true })).toEqual({
      dryRun: true,
      would: expect.objectContaining({ action: "inserted", asiakasForeignKeyId: null }),
    });
    expect(c.post).not.toHaveBeenCalled();
  });

  test("a blank key exits 4 before any request", async () => {
    const c = aliasClient([]);
    await expect(runCustomerFkAdd(c, 1496, { source: "betomik-orderbook", key: "  ", owner: 27 }, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(c.get).not.toHaveBeenCalled();
  });
});

describe("customer fk remove --key", () => {
  test("removes the one spelling, leaving the others", async () => {
    const c = aliasClient([alias(60, "vepe"), alias(61, "vepe security")]);
    const out = await runCustomerFkRemove(c, 1496, undefined, { owner: 27, key: "Vepe" }, {});
    expect(c.delete).toHaveBeenCalledWith("/api/foreignKey/customer/60/27", { headers: {} });
    expect(out).toMatchObject({ asiakasForeignKeyId: 60, key: "vepe" });
  });

  test("the same key on two sources needs --source; --source picks one", async () => {
    const c = aliasClient([{ ...ROW, foreignKey: "vepe" }, alias(60, "vepe")]);
    await expect(runCustomerFkRemove(c, 1496, undefined, { owner: 27, key: "vepe" }, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(await runCustomerFkRemove(c, 1496, undefined, { owner: 27, key: "vepe", source: "betomik-orderbook" }, { dryRun: true })).toEqual({
      dryRun: true,
      would: expect.objectContaining({ asiakasForeignKeyId: 60 }),
    });
    expect(c.delete).not.toHaveBeenCalled();
  });

  test("usage errors (neither / both of id and --key, --source with an id) exit 4 before any request (fb#2036)", async () => {
    const c = aliasClient([alias(60, "vepe")]);
    await expect(runCustomerFkRemove(c, 1496, undefined, { owner: 27 }, {})).rejects.toMatchObject({ exitCode: 4 });
    await expect(runCustomerFkRemove(c, 1496, "60", { owner: 27, key: "vepe" }, {})).rejects.toMatchObject({ exitCode: 4 });
    await expect(runCustomerFkRemove(c, 1496, "60", { owner: 27, source: "betomik-orderbook" }, {})).rejects.toMatchObject({ exitCode: 4 });
    expect(c.get).not.toHaveBeenCalled();
  });

  test("an unknown key exits 5", async () => {
    const c = aliasClient([alias(60, "vepe")]);
    await expect(runCustomerFkRemove(c, 1496, undefined, { owner: 27, key: "srg" }, {})).rejects.toMatchObject({ exitCode: 5 });
    expect(c.delete).not.toHaveBeenCalled();
  });
});

describe("customer fk import", () => {
  test("one GET per customer, in-file repeats unchanged, a bad row or a 409 fails only itself", async () => {
    const c = aliasClient([alias(60, "vepe")]);
    c.post
      .mockResolvedValueOnce({ action: "inserted", asiakasForeignKeyId: 901 })
      .mockRejectedValueOnce(new Error('foreignKey "srg" is already on customer 1469'));
    const out = await runCustomerFkImport(
      c,
      [
        { asiakasId: 1496, key: "vepe" },
        { asiakasId: 1496, key: "vepe security" },
        { asiakasId: 1496, key: "Vepe Security " },
        { asiakasId: 1496, key: "srg" },
        { asiakasId: 0, key: "x" },
        { asiakasId: 1496, key: "y", source: "nope" },
      ],
      { source: "betomik-orderbook", owner: 27 },
      {}
    );
    expect(c.get.mock.calls.filter(([p]) => String(p).startsWith("/api/foreignKey/customer/"))).toHaveLength(1);
    expect(c.post).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => (r.ok ? r.action : "failed"))).toEqual(["unchanged", "inserted", "unchanged", "failed", "failed", "failed"]);
    expect(out.results[3].error).toMatch(/customer 1469/);
    expect(out).toMatchObject({ ok: 3, failed: 3, inserted: 1, unchanged: 2 });
  });

  test("--dry-run sends nothing and marks the envelope", async () => {
    const c = aliasClient([]);
    const out = await runCustomerFkImport(c, [{ asiakasId: 1496, key: "vepe" }], { source: "betomik-orderbook", owner: 27 }, { dryRun: true });
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dryRun: true, inserted: 1 });
  });
});
