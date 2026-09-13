import { describe, test, expect } from "vitest";
import { mockApiClient, type MockApiClient } from "../helpers/mockClient.js";
import { CliError } from "../../src/api/errors.js";
import {
  planPersonFkSet,
  runPersonFkImport,
  runPersonFkList,
  runPersonFkRemove,
  runPersonFkSet,
} from "../../src/commands/person/fk.js";

const SOURCES = [
  { foreignKeySourceId: 1, foreignKeySourceName: "default", foreignKeySourceColumn: null, ownerAsiakasId: null },
  { foreignKeySourceId: 42, foreignKeySourceName: "betomik-orderbook", foreignKeySourceColumn: "rowKey", ownerAsiakasId: 27 },
];
const ROW = {
  personForeignKeyId: 900,
  personId: 6354,
  foreignKey: "Tomppa",
  foreignKeySourceId: 42,
  foreignKeyText: null,
  ownerAsiakasId: 27,
  isDisabled: false,
  entryTime: "2026-09-13T00:00:00.000Z",
};

/** get() answers the source list and the person's rows by path. */
function client(rows: unknown[] = [], sources: unknown[] = SOURCES): MockApiClient {
  const c = mockApiClient();
  c.get.mockImplementation(async (path: string) =>
    path.startsWith("/api/foreignKey/sourceList/") ? sources : rows
  );
  c.post.mockResolvedValue({ rowsAffected: [1] });
  return c;
}

describe("planPersonFkSet", () => {
  test("no row on that source+key → inserted with a null id", () => {
    expect(planPersonFkSet([ROW], 1, "Tomppa", undefined, false)).toEqual({
      action: "inserted",
      row: null,
      body: { personForeignKeyId: null, foreignKey: "Tomppa", foreignKeySourceId: 1, foreignKeyText: null, isDisabled: false },
    });
  });

  test("same key modulo trim/case → unchanged, no body", () => {
    expect(planPersonFkSet([ROW], 42, "  tomppa ", undefined, false)).toEqual({ action: "unchanged", row: ROW, body: null });
  });

  test("text or disabled differs → updated by id; omitted text keeps the stored one", () => {
    const withText = { ...ROW, foreignKeyText: "sheet spelling" };
    expect(planPersonFkSet([withText], 42, "Tomppa", undefined, true)).toEqual({
      action: "updated",
      row: withText,
      body: { personForeignKeyId: 900, foreignKey: "Tomppa", foreignKeySourceId: 42, foreignKeyText: "sheet spelling", isDisabled: true },
    });
    expect(planPersonFkSet([withText], 42, "Tomppa", "", false).body?.foreignKeyText).toBe("");
  });
});

describe("person fk list", () => {
  test("resolves source names and projects the raw rows", async () => {
    const c = client([ROW, { ...ROW, personForeignKeyId: 901, foreignKeySourceId: 99, foreignKey: "x" }]);
    const out = await runPersonFkList(c, "6354", 27);
    expect(c.get).toHaveBeenCalledWith("/api/person/getForeignKeys/6354/27");
    expect(out.items).toEqual([
      { personForeignKeyId: 900, key: "Tomppa", source: "betomik-orderbook", sourceId: 42, text: null, isDisabled: false, entryTime: ROW.entryTime },
      { personForeignKeyId: 901, key: "x", source: null, sourceId: 99, text: null, isDisabled: false, entryTime: ROW.entryTime },
    ]);
    expect(out.count).toBe(2);
  });
});

describe("person fk set", () => {
  test("inserts with write headers and reports the plan", async () => {
    const c = client([]);
    const out = await runPersonFkSet(c, "6354", { source: "betomik-orderbook", key: "Tomppa", owner: 27 }, { reason: "T5" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/person/saveForeignKey/6354/27",
      { personForeignKeyId: null, foreignKey: "Tomppa", foreignKeySourceId: 42, foreignKeyText: null, isDisabled: false },
      { headers: { "X-Action-Reason": "T5" } }
    );
    expect(out).toEqual({ personId: 6354, ownerAsiakasId: 27, source: "betomik-orderbook", sourceId: 42, key: "Tomppa", action: "inserted", personForeignKeyId: null });
  });

  test("unchanged → no POST; dry-run → no POST, would-plan echoed", async () => {
    const c = client([ROW]);
    expect(await runPersonFkSet(c, "6354", { source: "42", key: "tomppa", owner: 27 }, {})).toMatchObject({ action: "unchanged" });
    expect(c.post).not.toHaveBeenCalled();
    const dry = await runPersonFkSet(c, "6354", { source: "42", key: "Toomas", owner: 27 }, { dryRun: true });
    expect(dry).toEqual({ dryRun: true, would: expect.objectContaining({ action: "inserted", key: "Toomas" }) });
    expect(c.post).not.toHaveBeenCalled();
  });

  test("unknown source → exit 4 listing the owner's sources", async () => {
    await expect(runPersonFkSet(client([]), "6354", { source: "nope", key: "k", owner: 27 }, {})).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringContaining("betomik-orderbook (42)"),
    });
  });
});

describe("person fk remove", () => {
  test("id not on that person+owner → exit 5, no POST", async () => {
    const c = client([ROW]);
    await expect(runPersonFkRemove(c, "6354", "901", { owner: 27 }, {})).rejects.toBeInstanceOf(CliError);
    await expect(runPersonFkRemove(c, "6354", "901", { owner: 27 }, {})).rejects.toMatchObject({ exitCode: 5 });
    expect(c.post).not.toHaveBeenCalled();
  });

  test("sends the -1 delete convention with the row's fields", async () => {
    const c = client([ROW]);
    const out = await runPersonFkRemove(c, "6354", "900", { owner: 27 }, { reason: "typo" });
    expect(c.post).toHaveBeenCalledWith(
      "/api/person/saveForeignKey/6354/27",
      { personForeignKeyId: 900, foreignKey: "Tomppa", foreignKeySourceId: -1, foreignKeyText: null, isDisabled: false },
      { headers: { "X-Action-Reason": "typo" } }
    );
    expect(out).toEqual({ action: "removed", personId: 6354, ownerAsiakasId: 27, personForeignKeyId: 900, key: "Tomppa", source: "betomik-orderbook", sourceId: 42 });
  });
});

describe("person fk import", () => {
  test("one GET per person, dedupes keys, keeps input order, counts actions", async () => {
    const c = client([ROW]);
    const out = await runPersonFkImport(
      c,
      [
        { personId: 6354, key: "Tomppa" },
        { personId: 6355, key: "Jani" },
        { personId: 6354, key: "Toomas" },
        { personId: 6354, key: "toomas " },
        { key: "orphan" },
        { personId: 6356, key: "x", source: "nope" },
      ],
      { source: "betomik-orderbook", owner: 27 },
      { reason: "T5" }
    );
    const personGets = c.get.mock.calls.filter(([p]) => String(p).startsWith("/api/person/getForeignKeys/"));
    expect(personGets.map(([p]) => p)).toEqual(["/api/person/getForeignKeys/6354/27", "/api/person/getForeignKeys/6355/27"]);
    expect(c.post).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => [r.personId, r.key, r.ok, r.action ?? r.error])).toEqual([
      [6354, "Tomppa", true, "unchanged"],
      [6355, "Jani", true, "inserted"],
      [6354, "Toomas", true, "inserted"],
      [6354, "toomas ", true, "unchanged"],
      [null, "orphan", false, expect.stringContaining("personId")],
      [6356, "x", false, expect.stringContaining("unknown foreign-key source")],
    ]);
    expect(out).toMatchObject({ ok: 4, failed: 2, inserted: 2, updated: 0, unchanged: 2 });
  });

  test("an in-file repeat with a different text/disabled fails its own row, never a POST with a fake id (fb#1687)", async () => {
    const c = client([]);
    const out = await runPersonFkImport(
      c,
      [{ personId: 1, key: "a" }, { personId: 1, key: "A ", disabled: true }, { personId: 1, key: "a", text: "x" }],
      { source: "42", owner: 27 },
      {}
    );
    expect(c.post).toHaveBeenCalledTimes(1);
    expect(c.post.mock.calls[0][1]).toMatchObject({ personForeignKeyId: null, foreignKey: "a" });
    expect(out.results.map((r) => [r.ok, r.action ?? r.error])).toEqual([
      [true, "inserted"],
      [false, expect.stringContaining("duplicate of row 1")],
      [false, expect.stringContaining("duplicate of row 1")],
    ]);
    expect(out).toMatchObject({ ok: 1, failed: 2, inserted: 1 });
  });

  test("dry-run plans every row and never POSTs", async () => {
    const c = client([]);
    const out = await runPersonFkImport(c, [{ personId: 1, key: "a" }], { source: "42", owner: 27 }, { dryRun: true });
    expect(c.post).not.toHaveBeenCalled();
    expect(out).toMatchObject({ dryRun: true, inserted: 1, results: [{ personId: 1, key: "a", ok: true, action: "inserted" }] });
  });
});
