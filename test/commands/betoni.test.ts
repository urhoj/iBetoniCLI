import { describe, test, expect, vi, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runLaatuList,
  runLaatuGet,
  runAttrList,
  runAttrGet,
  runReference,
} from "../../src/commands/betoni/index.js";
import { CliError } from "../../src/api/errors.js";

/**
 * A JWT whose ownerAsiakasId claim is 8 — the default scope for every command
 * here. Built as a real (unsigned) token because the owner resolver DECODES it;
 * a stub string would send every test down the server-fallback path instead of
 * the one production takes.
 */
function tokenFor(ownerAsiakasId: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ ownerAsiakasId })}.sig`;
}

const client = mockApiClient({ getCurrentToken: vi.fn(() => tokenFor(8)) });

// Straight from dbo.betoniLaatuView: laatuId 1 is SHARED (asiakasId 0), 2 and 3
// belong to supplier 8. The backend returns them mixed, in sortNum order, with
// no marker distinguishing the two populations.
const LAATU_ROWS = [
  { laatuId: 1, laatuNimike: "C25/30 Rapid", laatuLyhenne: "C25R", laatuSelite: "yhteinen", sortNum: 1, asiakasId: 0, isEnabled: true, showInDropDown: true },
  { laatuId: 2, laatuNimike: "C30/37", laatuLyhenne: "C30", laatuSelite: "oma", sortNum: 2, asiakasId: 8, isEnabled: true, showInDropDown: true },
  { laatuId: 3, laatuNimike: "C35/45 Rapid", laatuLyhenne: "C35R", laatuSelite: null, sortNum: 3, asiakasId: 8, isEnabled: false, showInDropDown: false },
];

beforeEach(() => {
  client.get.mockReset();
});

describe("ib betoni laatu list", () => {
  test("reads the ACTIVE company's catalogue when --asiakas is absent", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    await runLaatuList(client);
    expect(client.get).toHaveBeenCalledWith("/api/betoni/laatu/list/8");
  });

  test("--asiakas reads ANOTHER supplier's catalogue (a customer reading its supplier)", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    await runLaatuList(client, { asiakas: 26 });
    expect(client.get).toHaveBeenCalledWith("/api/betoni/laatu/list/26");
  });

  // The whole point of the domain: asiakasId 0 is the shared pool and the
  // backend gives no marker, so every caller had to rediscover the sentinel.
  test("derives `shared` from the asiakasId 0 sentinel, preserving every other column", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    const { items } = await runLaatuList(client);
    expect(items.map((r) => [r.laatuId, r.shared])).toEqual([[1, true], [2, false], [3, false]]);
    // Untouched passthrough — a projection that dropped columns would be worse
    // than no command at all.
    expect(items[0]).toMatchObject({ laatuNimike: "C25/30 Rapid", sortNum: 1, isEnabled: true });
  });

  test("--shared-only / --own-only split the two populations the response mixes", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    const shared = await runLaatuList(client, { sharedOnly: true });
    expect(shared.items.map((r) => r.laatuId)).toEqual([1]);
    client.get.mockResolvedValue(LAATU_ROWS);
    const own = await runLaatuList(client, { ownOnly: true });
    expect(own.items.map((r) => r.laatuId)).toEqual([2, 3]);
  });

  test("--shared-only with --own-only exits 4 — they are disjoint sets, not a filter pair", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    await expect(runLaatuList(client, { sharedOnly: true, ownOnly: true })).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  test("--search matches nimike/lyhenne/selite, case-insensitively, and tolerates nulls", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    const { items } = await runLaatuList(client, { search: "RAPID" });
    // laatuId 3 has a null laatuSelite — the filter must not throw on it.
    expect(items.map((r) => r.laatuId)).toEqual([1, 3]);
  });

  test("an empty catalogue is an empty envelope, not a crash", async () => {
    client.get.mockResolvedValue([]);
    expect((await runLaatuList(client)).count).toBe(0);
  });

  test("a null body (no rows at all) does not throw", async () => {
    client.get.mockResolvedValue(null);
    expect((await runLaatuList(client)).items).toEqual([]);
  });
});

describe("ib betoni laatu get", () => {
  test("resolves from the list, since the backend mounts no get route", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    const row = await runLaatuGet(client, 2);
    expect(client.get).toHaveBeenCalledWith("/api/betoni/laatu/list/8");
    expect(row).toMatchObject({ laatuId: 2, laatuNimike: "C30/37", shared: false });
  });

  test("a shared grade is gettable and marked shared", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    expect(await runLaatuGet(client, 1)).toMatchObject({ shared: true });
  });

  test("unknown id exits 5 and says the grade may belong to another supplier", async () => {
    client.get.mockResolvedValue(LAATU_ROWS);
    const err = await runLaatuGet(client, 999).catch((e) => e as CliError);
    expect(err.exitCode).toBe(5);
    expect(err.hint).toMatch(/--asiakas/);
  });
});

const ATTR_ROWS = [
  { attrId: 10, attrNimike: "Kuitu", attrSelite: null, attrYksikkö: "kg", hinta: 12.5, betoniAsiakasId: 0, ownerAsiakasId: 0, isEnabled: true, showInDropDown: true },
  { attrId: 11, attrNimike: "Kiihdytin", attrSelite: null, attrYksikkö: "l", hinta: null, betoniAsiakasId: 8, ownerAsiakasId: 0, isEnabled: true, showInDropDown: true },
  { attrId: 12, attrNimike: "Oma lisä", attrSelite: null, attrYksikkö: "kg", hinta: 3, betoniAsiakasId: 8, ownerAsiakasId: 8, isEnabled: true, showInDropDown: true },
];

describe("ib betoni attr list", () => {
  test("builds the two-segment path with the active company as owner", async () => {
    client.get.mockResolvedValue(ATTR_ROWS);
    await runAttrList(client, 8);
    expect(client.get).toHaveBeenCalledWith("/api/betoni/attr/list/8/8");
  });

  test("--owner overrides only the owner segment", async () => {
    client.get.mockResolvedValue(ATTR_ROWS);
    await runAttrList(client, 0, { owner: 1349 });
    expect(client.get).toHaveBeenCalledWith("/api/betoni/attr/list/0/1349");
  });

  // Both columns use 0 as "any" and the backend matches each INDEPENDENTLY, so
  // a row global on one axis is still scoped on the other. Only 0/0 is truly
  // visible to everyone — treating a single 0 as "shared" would over-claim.
  test("`shared` requires BOTH scope columns to be 0", async () => {
    client.get.mockResolvedValue(ATTR_ROWS);
    const { items } = await runAttrList(client, 8);
    expect(items.map((r) => [r.attrId, r.shared])).toEqual([[10, true], [11, false], [12, false]]);
  });

  test("a null hinta is preserved as null — 'no price set', not 0", async () => {
    client.get.mockResolvedValue(ATTR_ROWS);
    const { items } = await runAttrList(client, 8);
    expect(items[1].hinta).toBeNull();
  });
});

describe("ib betoni attr get", () => {
  test("unwraps the single-row RECORDSET the route returns", async () => {
    client.get.mockResolvedValue([ATTR_ROWS[2]]);
    const row = await runAttrGet(client, 12);
    expect(client.get).toHaveBeenCalledWith("/api/betoni/attr/get/12/8");
    expect(row).toMatchObject({ attrId: 12, shared: false });
    expect(Array.isArray(row)).toBe(false);
  });

  test("an empty recordset exits 5 and names the cross-tenant ambiguity", async () => {
    client.get.mockResolvedValue([]);
    const err = await runAttrGet(client, 999).catch((e) => e as CliError);
    expect(err.exitCode).toBe(5);
    // The backend cannot distinguish "not yours" from "does not exist", and the
    // remedy has to say so rather than assert the row is absent.
    expect(err.hint).toMatch(/another tenant/i);
  });
});

describe("ib betoni reference", () => {
  test("fetches all four lists and keys them by kind", async () => {
    client.get
      .mockResolvedValueOnce([{ raekoko: 16 }])
      .mockResolvedValueOnce([{ lujuus: "C30" }])
      .mockResolvedValueOnce([{ notkeus: "S3" }])
      .mockResolvedValueOnce([{ kayttoika: 50 }]);
    const out = await runReference(client);
    expect(Object.keys(out)).toEqual(["raekoko", "lujuus", "notkeus", "kayttoika"]);
    expect(client.get.mock.calls.map((c) => c[0])).toEqual([
      "/api/betoni/raekoko/list",
      "/api/betoni/lujuus/list",
      "/api/betoni/notkeus/list",
      "/api/betoni/kayttoika/list",
    ]);
  });

  test("--kind narrows to one list and makes exactly ONE request", async () => {
    client.get.mockResolvedValue([{ raekoko: 16 }]);
    const out = await runReference(client, { kind: "raekoko" });
    expect(Object.keys(out)).toEqual(["raekoko"]);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test("an unknown --kind exits 4 instead of silently returning nothing", async () => {
    await expect(runReference(client, { kind: "bogus" })).rejects.toMatchObject({ exitCode: 4 });
  });

  test("an EMPTY --kind ('--kind=') also exits 4 — no longer silently returns all lists", async () => {
    // Pre-assertEnum behavior treated a falsy kind as absent; an explicitly
    // provided empty value is now rejected like any other invalid enum value.
    await expect(runReference(client, { kind: "" })).rejects.toMatchObject({ exitCode: 4 });
    expect(client.get).not.toHaveBeenCalled();
  });

  test("a list that comes back null becomes [], so the shape is stable", async () => {
    client.get.mockResolvedValue(null);
    expect(await runReference(client, { kind: "lujuus" })).toEqual({ lujuus: [] });
  });
});
