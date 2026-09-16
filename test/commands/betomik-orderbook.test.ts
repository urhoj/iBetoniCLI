import { describe, test, expect, beforeEach } from "vitest";
import { mockApiClient } from "../helpers/mockClient.js";
import {
  runBetomikOrderbookImport,
  runBetomikOrderbookRuns,
  runBetomikOrderbookRows,
  runBetomikOrderbookReview,
  runBetomikOrderbookPropose,
  runBetomikOrderbookAiStats,
  runBetomikOrderbookSyncProgress,
  runBetomikOrderbookSync,
  runBetomikOrderbookResync,
  runBetomikOrderbookExtractPrompt,
  runBetomikOrderbookExceptions,
  runBetomikOrderbookFleet,
  runBetomikOrderbookAudit,
  runBetomikOrderbookSyncRows,
  selectRowsToSync,
} from "../../src/commands/betomikOrderbook/index.js";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { CliError, hintDetailForError } from "../../src/api/errors.js";

const mockClient = mockApiClient();

describe("ib dev betomik-orderbook import", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
  });

  test("runBetomikOrderbookImport forwards the body verbatim + all three write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({ importRunId: 42, rowCount: 3 });
    const body = {
      sheetLabel: "KAIKKI 40 / 2026",
      isoYear: 2026,
      isoWeek: 40,
      rows: [{ driver_name: "Kaitsu" }, { driver_name: "Soini" }, { driver_name: "Heiti" }],
    };
    const result = await runBetomikOrderbookImport(mockClient, body, {
      dryRun: true,
      idempotencyKey: "week-40-import",
      reason: "manual weekly import",
    });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/import",
      body,
      {
        headers: {
          "X-Dry-Run": "1",
          "Idempotency-Key": "week-40-import",
          "X-Action-Reason": "manual weekly import",
        },
      }
    );
    expect((result as { importRunId: number }).importRunId).toBe(42);
  });
});

describe("ib dev betomik-orderbook runs / rows", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
  });

  test("runs: GET /api/betomik-orderbook/runs, unwraps {items} into a ListEnvelope", async () => {
    mockClient.get.mockResolvedValueOnce({
      items: [{ importRunId: 1, sheetLabel: "KAIKKI 37 / 2026", isoYear: 2026, isoWeek: 37, rowCount: 176 }],
    });
    const result = await runBetomikOrderbookRuns(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs");
    expect(result).toEqual({
      items: [{ importRunId: 1, sheetLabel: "KAIKKI 37 / 2026", isoYear: 2026, isoWeek: 37, rowCount: 176 }],
      nextCursor: null,
      count: 1,
    });
  });

  test("runs: a non-envelope body yields an empty envelope, never a throw", async () => {
    mockClient.get.mockResolvedValueOnce(null);
    const result = await runBetomikOrderbookRuns(mockClient);
    expect(result).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("rows: GET /api/betomik-orderbook/runs/:runId/rows with the parsed id", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [{ plate: "GNG-544", m3: 12.5, sourceType: "betomik_self" }] });
    const result = await runBetomikOrderbookRows(mockClient, 7);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/7/rows");
    expect(result.count).toBe(1);
    expect(result.items[0]).toMatchObject({ plate: "GNG-544", m3: 12.5 });
  });
});

describe("ib dev betomik-orderbook review / propose / ai-stats", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
    mockClient.get.mockReset();
  });

  test("review: POST /rows/:rowId/review with the override body + write-flag headers", async () => {
    mockClient.post.mockResolvedValueOnce({ updated: true });
    const result = await runBetomikOrderbookReview(
      mockClient,
      143,
      { status: "approved", rowKind: "palkki", palkkiType: "pois ajosta" },
      { reason: "Halli-rivi", dryRun: true }
    );
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/rows/143/review",
      { status: "approved", rowKind: "palkki", palkkiType: "pois ajosta" },
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "Halli-rivi" } }
    );
    expect(result).toEqual({ updated: true });
  });

  test("propose: POST /runs/:runId/propose with provider/force + headers", async () => {
    mockClient.post.mockResolvedValueOnce({ runId: 1, proposed: 175, failed: 1 });
    await runBetomikOrderbookPropose(mockClient, 1, { provider: "local", force: true }, { reason: "bake-off" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/runs/1/propose",
      { provider: "local", force: true },
      { headers: { "X-Action-Reason": "bake-off" } }
    );
  });

  test("ai-stats: GET /runs/:runId/ai-stats, body returned as-is", async () => {
    mockClient.get.mockResolvedValueOnce({ runId: 1, scored: 3, humanAgreement: { rowKind: { n: 3, agree: 3, rate: 1 } } });
    const result = await runBetomikOrderbookAiStats(mockClient, 1);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/1/ai-stats");
    expect((result as { scored: number }).scored).toBe(3);
  });

  test("sync-progress: GET /runs/:runId/sync-progress, body returned as-is", async () => {
    mockClient.get.mockResolvedValueOnce({ running: true, phase: "rows", done: 3, total: 10 });
    const result = await runBetomikOrderbookSyncProgress(mockClient, 1);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/1/sync-progress");
    expect((result as { done: number }).done).toBe(3);
  });
});

describe("ib dev betomik-orderbook sync / resync / extract-prompt / exceptions / audit", () => {
  beforeEach(() => {
    mockClient.post.mockReset();
    mockClient.get.mockReset();
  });

  test("sync: POST /api/betomik-orderbook/sync forwards body incl. mode/provider/digest + write headers", async () => {
    mockClient.post.mockResolvedValueOnce({ upsert: {}, summary: {} });
    const body = {
      sheetLabel: "x",
      isoYear: 2026,
      isoWeek: 38,
      rows: [] as unknown[],
      mode: "create",
      provider: "local",
      digest: true,
    };
    await runBetomikOrderbookSync(mockClient, body, { dryRun: true, reason: "tick" });
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/sync",
      expect.objectContaining({ mode: "create", provider: "local", digest: true }),
      { headers: { "X-Dry-Run": "1", "X-Action-Reason": "tick" } }
    );
  });

  test("resync: POST /api/betomik-orderbook/runs/:runId/sync with the mode/provider body", async () => {
    mockClient.post.mockResolvedValueOnce({});
    await runBetomikOrderbookResync(mockClient, 5, { mode: "full" }, {});
    expect(mockClient.post).toHaveBeenCalledWith(
      "/api/betomik-orderbook/runs/5/sync",
      { mode: "full" },
      { headers: {} }
    );
  });

  test("extract-prompt: GET /api/betomik-orderbook/extract-prompt, body returned as-is", async () => {
    mockClient.get.mockResolvedValueOnce({ system: "s", schema: {}, cells: [], toolName: "t" });
    const result = await runBetomikOrderbookExtractPrompt(mockClient);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/extract-prompt");
    expect(result).toEqual({ system: "s", schema: {}, cells: [], toolName: "t" });
  });

  test("exceptions: GET /api/betomik-orderbook/runs/:runId/exceptions, unwraps {items} into a ListEnvelope", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [{ auditId: 1 }] });
    const result = await runBetomikOrderbookExceptions(mockClient, 5);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/5/exceptions");
    expect(result).toEqual({ items: [{ auditId: 1 }], nextCursor: null, count: 1 });
  });

  test("fleet: GET /api/betomik-orderbook/runs/:runId/fleet, passes the diff document through unchanged", async () => {
    const doc = { vehicles: [], pseudo: [], notInSheet: [], summary: { sheetVehicles: 0, withFindings: 0, notInSheet: 0, pseudo: 0 } };
    mockClient.get.mockResolvedValueOnce(doc);
    const result = await runBetomikOrderbookFleet(mockClient, 2);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/2/fleet");
    expect(result).toBe(doc);
  });

  test("audit: GET /api/betomik-orderbook/audit?since=<iso>, unwraps {items} into a ListEnvelope", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [] });
    const result = await runBetomikOrderbookAudit(mockClient, { since: "2026-09-13" });
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/audit?since=2026-09-13");
    expect(result).toEqual({ items: [], nextCursor: null, count: 0 });
  });

  test("audit: no --since omits the query string entirely", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [] });
    await runBetomikOrderbookAudit(mockClient, {});
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/audit");
  });
});

// fb#1681 — `sync`'s single combined 400 row used to mix four causes into one
// meaning/remedy pair. Two of them (provider not configured, too many un-extracted
// rows) only fire on a REAL sync — POST /sync short-circuits before reaching either
// check on --dry-run. Splitting the row without a `match` on the new one would have
// silently reintroduced fb#485 (matchHttpRow's status-only catch-all always wins when
// no row's `match` hits), so these assert against the REAL puminet5api message text
// (routes/betomikOrderbookRoutes.js:319, modules/betomikOrderbook/llm.js:125) to prove
// each cause reaches its own remedy rather than the generic payload one.
describe("ib dev betomik-orderbook sync — 400 remedy disambiguation (fb#1681)", () => {
  const syncErrors = () =>
    COMMAND_SPECS.find((s) => s.command === "ib dev betomik-orderbook sync")!.errors;

  test("a real 'no LLM provider configured' 400 gets the provider remedy", () => {
    const err = new CliError(
      "Yhtään LLM-tarjoajaa ei saatu käyttöön: bedrock: Bedrock ei ole konfiguroitu (AI_BEDROCK_MODEL / AI_BEDROCK_ENABLED)",
      400, null, 4
    );
    expect(hintDetailForError(err, syncErrors()).hint).toMatch(/AI_BEDROCK_MODEL|AI_LOCAL_BASE_URL/);
  });

  test("a real 'too many un-extracted rows' 400 gets the extractor-script remedy", () => {
    const err = new CliError(
      "yli 40 riviä ilman extracted-kenttää — aja LAN-poiminta (betomik-orderbook-extract.py) ensin",
      400, null, 4
    );
    expect(hintDetailForError(err, syncErrors()).hint).toMatch(/betomik-orderbook-extract\.py/);
  });

  test("a real missing-fields 400 still falls to the general payload remedy", () => {
    const err = new CliError("sheetLabel, isoYear, isoWeek ja vähintään yksi rows-alkio vaaditaan", 400, null, 4);
    expect(hintDetailForError(err, syncErrors()).hint).toMatch(/--mode shadow\|create\|full/);
  });
});

describe("ib dev betomik-orderbook sync-row (the validator's Vie betoni.onlineen, per row)", () => {
  beforeEach(() => {
    mockClient.get.mockReset();
    mockClient.post.mockReset();
  });

  test("POSTs /rows/:rowId/sync once per id, in order, with the provider body and the write headers; one Idempotency-Key per row", async () => {
    mockClient.post
      .mockResolvedValueOnce({ summary: { written: { create: 1, update: 0, delete: 0 }, errors: [] }, row: { betomikOrderbookImportRowId: 7, syncStatus: "synced", plannedAction: "create", keikkaId: 123, palkkiId: null, rowKind: "keikka", palkkiType: null, blockReason: null } })
      .mockResolvedValueOnce({ summary: { written: { create: 0, update: 0, delete: 0 }, errors: [] }, row: { betomikOrderbookImportRowId: 8, syncStatus: "blocked", plannedAction: "create", keikkaId: null, palkkiId: null, rowKind: "keikka", palkkiType: null, blockReason: 'customer:missing; unresolved:customer' } });
    const result = await runBetomikOrderbookSyncRows(mockClient, [7, 8], { provider: "local" }, { reason: "week 40", idempotencyKey: "wk40" });
    expect(mockClient.post).toHaveBeenNthCalledWith(1, "/api/betomik-orderbook/rows/7/sync", { provider: "local" }, { headers: { "Idempotency-Key": "wk40:7", "X-Action-Reason": "week 40" } });
    expect(mockClient.post).toHaveBeenNthCalledWith(2, "/api/betomik-orderbook/rows/8/sync", { provider: "local" }, { headers: { "Idempotency-Key": "wk40:8", "X-Action-Reason": "week 40" } });
    expect(result.items).toEqual([
      { rowId: 7, ok: true, syncStatus: "synced", plannedAction: "create", rowKind: "keikka", palkkiType: null, keikkaId: 123, palkkiId: null, blockReason: null, written: { create: 1, update: 0, delete: 0 }, errors: [] },
      { rowId: 8, ok: true, syncStatus: "blocked", plannedAction: "create", rowKind: "keikka", palkkiType: null, keikkaId: null, palkkiId: null, blockReason: "customer:missing; unresolved:customer", written: { create: 0, update: 0, delete: 0 }, errors: [] },
    ]);
    expect(result.summary).toEqual({ rows: 2, synced: 1, blocked: 1, removed: 0, pending: 0, failed: 0 });
    expect(result.count).toBe(2);
    expect("dryRun" in result).toBe(false);
  });

  test("--dry-run: X-Dry-Run on every request, and the envelope carries the top-level dryRun marker", async () => {
    mockClient.post.mockResolvedValue({ dryRun: true, summary: { written: { create: 0, update: 0, delete: 0 }, errors: [] }, row: { betomikOrderbookImportRowId: 7, syncStatus: "blocked", plannedAction: "create", blockReason: 'customer:new "Peab Oy"' } });
    const result = await runBetomikOrderbookSyncRows(mockClient, [7], {}, { dryRun: true });
    expect(mockClient.post).toHaveBeenCalledWith("/api/betomik-orderbook/rows/7/sync", {}, { headers: { "X-Dry-Run": "1" } });
    expect(result.dryRun).toBe(true);
    expect(result.items[0].blockReason).toBe('customer:new "Peab Oy"');
  });

  test("a row that fails does not abort the batch: it is reported with ok:false and counted as failed", async () => {
    mockClient.post
      .mockRejectedValueOnce(new CliError("row 9 not found", 404, null, 5))
      .mockResolvedValueOnce({ summary: { written: { create: 1, update: 0, delete: 0 }, errors: [] }, row: { betomikOrderbookImportRowId: 10, syncStatus: "synced", plannedAction: "create", keikkaId: 124 } });
    const result = await runBetomikOrderbookSyncRows(mockClient, [9, 10], {}, {});
    expect(result.items[0]).toEqual({ rowId: 9, ok: false, error: "row 9 not found", statusCode: 404 });
    expect(result.items[1].keikkaId).toBe(124);
    expect(result.summary).toEqual({ rows: 2, synced: 1, blocked: 0, removed: 0, pending: 0, failed: 1 });
  });

  test("selectRowsToSync: --run picks the run's rows in the given statuses (default pending, blocked, gone), by id", async () => {
    mockClient.get.mockResolvedValueOnce({ items: [
      { betomikOrderbookImportRowId: 30, syncStatus: "synced" },
      { betomikOrderbookImportRowId: 12, syncStatus: "blocked" },
      { betomikOrderbookImportRowId: 11, syncStatus: "pending" },
      { betomikOrderbookImportRowId: 13, syncStatus: "removed" },
      { betomikOrderbookImportRowId: 14, syncStatus: "gone" },
    ] });
    expect(await selectRowsToSync(mockClient, 4, undefined)).toEqual([11, 12, 14]);
    expect(mockClient.get).toHaveBeenCalledWith("/api/betomik-orderbook/runs/4/rows");
    mockClient.get.mockResolvedValueOnce({ items: [{ betomikOrderbookImportRowId: 30, syncStatus: "synced" }, { betomikOrderbookImportRowId: 12, syncStatus: "blocked" }] });
    expect(await selectRowsToSync(mockClient, 4, "synced")).toEqual([30]);
  });

  test("the spec exists, is developer-only, accepts write flags with a server dry run, and hints the client-side usage errors", () => {
    const spec = COMMAND_SPECS.find((s) => s.command === "ib dev betomik-orderbook sync-row");
    expect(spec).toBeDefined();
    expect(spec?.tier).toBe("developer");
    expect(spec?.writeFlags).toBe(true);
    expect(spec?.dryRunKind).toBe("server");
    expect(spec?.args?.[0]?.name).toBe("rowId");
    expect(spec?.flags?.map((f) => f.name)).toEqual(expect.arrayContaining(["run", "status", "provider"]));
    const usage = new CliError("Pass row ids or --run <runId>, not neither", 0, null, 4);
    expect(hintDetailForError(usage, spec?.errors).hint).toMatch(/--run/);
  });
});
