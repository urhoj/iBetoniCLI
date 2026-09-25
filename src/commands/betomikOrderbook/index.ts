import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type WriteFlags, writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { addJsonBodyOptions, resolveJsonBody, type JsonBodyFlags } from "../_shared/jsonBody.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { writeJson, failWith } from "../../output/json.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { parseId, intFlag } from "../../targets.js";

export async function runBetomikOrderbookImport(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/import", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface BetomikRunRow {
  importRunId: number;
  sheetLabel: string;
  isoYear: number;
  isoWeek: number;
  importedAt?: string;
  importedBy?: number | null;
  rowCount: number;
}

function itemsOf<T>(raw: unknown): T[] {
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** Client-side --limit/--offset over an unpaged route's full result (fb#1953). */
function page<T>(items: T[], { limit, offset }: { limit?: number; offset?: number }): ListEnvelope<T> {
  if (limit === undefined && offset === undefined) return listEnvelope(items);
  const start = offset ?? 0;
  const end = limit === undefined ? items.length : start + limit;
  const truncated = end < items.length;
  return listEnvelope(items.slice(start, end), {
    truncated,
    ...(truncated ? { hint: `${items.length - end} more row(s) — re-run with --offset ${end}` } : {}),
  });
}

/**
 * Import runs for the Betomik staging table, newest first (GET /api/betomik-orderbook/runs).
 * The route is unpaged, so --limit/--offset slice client-side like `rows` (fb#1953).
 */
export async function runBetomikOrderbookRuns(
  client: ApiClient,
  filter: { limit?: number; offset?: number } = {}
): Promise<ListEnvelope<BetomikRunRow>> {
  const raw = await client.get<unknown>("/api/betomik-orderbook/runs");
  return page(itemsOf<BetomikRunRow>(raw), filter);
}

export interface BetomikRowsFilter {
  /** CSV of syncStatus values to keep (pending|blocked|synced|gone|frozen). */
  status?: string;
  limit?: number;
  offset?: number;
  /** false (`--no-raw`) drops rawJson from every row. */
  raw?: boolean;
}

/** Every syncStatus the ledger can hold; `removed` is server-excluded (fb#1722). */
const ROW_SYNC_STATUSES = ["pending", "blocked", "synced", "gone", "frozen"];

/**
 * Staging rows of one import run (GET /api/betomik-orderbook/runs/:runId/rows).
 * The route has no paging and returns every non-removed row of the run (a
 * re-imported week carries its frozen rows beside the live ones — 415 for
 * week 37), so --status / --limit / --offset / --no-raw are applied HERE, on the
 * fetched set (fb#1736/fb#1723). The status predicate is the one sync-row
 * --run uses.
 */
export async function runBetomikOrderbookRows(
  client: ApiClient,
  runId: number,
  filter: BetomikRowsFilter = {}
): Promise<ListEnvelope<Record<string, unknown>>> {
  const wanted = (filter.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = wanted.filter((s) => !ROW_SYNC_STATUSES.includes(s));
  if (bad.length) {
    failWith(
      `--status: unknown value${bad.length > 1 ? "s" : ""} ${bad.join(", ")} — accepted: ${ROW_SYNC_STATUSES.join(", ")}`,
      4,
      bad.includes("removed")
        ? "removed rows are excluded by the route itself (fb#1722) and cannot be listed — read one by id with `ib dev betomik-orderbook row <rowId>`"
        : undefined
    );
  }
  const raw = await client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/rows`);
  let items = itemsOf<Record<string, unknown>>(raw);
  if (wanted.length) items = items.filter((r) => wanted.includes(String(r.syncStatus)));
  if (filter.raw === false) items = items.map(({ rawJson: _raw, ...rest }) => rest);
  return page(items, filter);
}

/**
 * One ledger row whatever its syncStatus (GET /api/betomik-orderbook/rows/:rowId,
 * fb#1977) — the only way to read a row that reached the terminal 'removed',
 * which `rows` cannot list (fb#1722).
 */
export async function runBetomikOrderbookRow(client: ApiClient, rowId: number, opts: { raw?: boolean } = {}): Promise<Record<string, unknown>> {
  const row = await client.get<Record<string, unknown>>(`/api/betomik-orderbook/rows/${rowId}`);
  if (opts.raw !== false || !row || typeof row !== "object") return row;
  const rest = { ...row };
  delete rest.rawJson;
  return rest;
}

export interface BetomikReviewBody {
  status: string;
  rowKind?: string;
  palkkiType?: string;
  notes?: string;
}

/** Review one staging row (POST /api/betomik-orderbook/rows/:rowId/review). */
export async function runBetomikOrderbookReview(
  client: ApiClient,
  rowId: number,
  body: BetomikReviewBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/rows/${rowId}/review`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Run the AI proposer over one run (POST /api/betomik-orderbook/runs/:runId/propose). */
export async function runBetomikOrderbookPropose(
  client: ApiClient,
  runId: number,
  body: { provider?: string; force?: boolean },
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/runs/${runId}/propose`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** AI-vs-human agreement for one run (GET /api/betomik-orderbook/runs/:runId/ai-stats). */
export async function runBetomikOrderbookAiStats(client: ApiClient, runId: number): Promise<unknown> {
  return client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/ai-stats`);
}

/** Progress of a running sync (GET /api/betomik-orderbook/runs/:runId/sync-progress). */
export async function runBetomikOrderbookSyncProgress(client: ApiClient, runId: number): Promise<unknown> {
  return client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/sync-progress`);
}

/** Sync a Betomik order-book payload to keikka/palkki rows (POST /api/betomik-orderbook/sync). */
export async function runBetomikOrderbookSync(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/sync", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** Re-run sync for an already-imported run (POST /api/betomik-orderbook/runs/:runId/sync). */
export async function runBetomikOrderbookResync(
  client: ApiClient,
  runId: number,
  body: { mode?: string; provider?: string },
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/betomik-orderbook/runs/${runId}/sync`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface BetomikSyncRowResult {
  rowId: number;
  ok: boolean;
  syncStatus?: string;
  plannedAction?: string;
  rowKind?: string;
  palkkiType?: string | null;
  keikkaId?: number | null;
  palkkiId?: number | null;
  blockReason?: string | null;
  written?: { create: number; update: number; delete: number };
  errors?: unknown[];
  error?: string;
  statusCode?: number;
}

export interface BetomikSyncRowsEnvelope extends ListEnvelope<BetomikSyncRowResult> {
  dryRun?: true;
  summary: { rows: number; synced: number; blocked: number; removed: number; pending: number; failed: number };
}

const DEFAULT_SYNC_ROW_STATUSES = "pending,blocked,gone";

/** The ledger rows of one run in the given statuses (default: the ones a sync would still act on), by id. */
export async function selectRowsToSync(client: ApiClient, runId: number, statuses?: string): Promise<number[]> {
  const wanted = new Set((statuses || DEFAULT_SYNC_ROW_STATUSES).split(",").map((s) => s.trim()).filter(Boolean));
  const { items } = await runBetomikOrderbookRows(client, runId);
  return items
    .filter((r) => wanted.has(String(r.syncStatus)))
    .map((r) => Number(r.betomikOrderbookImportRowId))
    .sort((a, b) => a - b);
}

/**
 * The validator's "Vie betoni.onlineen" button, row by row (POST
 * /api/betomik-orderbook/rows/:rowId/sync): each row is its own request, so a
 * week never hits the edge's request timeout and a failing row never aborts the
 * rest. With --dry-run the server extracts, plans and reports what it WOULD
 * create (customer:new "…", worksite:new "…") without writing — the safe pass
 * to read before the real one. One Idempotency-Key per row when one is given.
 */
export async function runBetomikOrderbookSyncRows(
  client: ApiClient,
  rowIds: number[],
  body: { provider?: string },
  flags: WriteFlags
): Promise<BetomikSyncRowsEnvelope> {
  const items: BetomikSyncRowResult[] = [];
  const summary = { rows: rowIds.length, synced: 0, blocked: 0, removed: 0, pending: 0, failed: 0 };
  for (const rowId of rowIds) {
    const perRow = flags.idempotencyKey ? { ...flags, idempotencyKey: `${flags.idempotencyKey}:${rowId}` } : flags;
    try {
      const res = (await client.post<unknown>(`/api/betomik-orderbook/rows/${rowId}/sync`, body, {
        headers: writeFlagsToHeaders(perRow),
      })) as { summary?: { written?: BetomikSyncRowResult["written"]; errors?: unknown[] }; row?: Record<string, unknown> };
      const row = res.row || {};
      const status = String(row.syncStatus ?? "");
      items.push({
        rowId,
        ok: true,
        syncStatus: status,
        plannedAction: row.plannedAction as string | undefined,
        rowKind: row.rowKind as string | undefined,
        palkkiType: (row.palkkiType as string | null | undefined) ?? null,
        keikkaId: (row.keikkaId as number | null | undefined) ?? null,
        palkkiId: (row.palkkiId as number | null | undefined) ?? null,
        blockReason: (row.blockReason as string | null | undefined) ?? null,
        written: res.summary?.written,
        errors: res.summary?.errors ?? [],
      });
      if (status === "synced" || status === "blocked" || status === "removed" || status === "pending") summary[status] += 1;
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      items.push({ rowId, ok: false, error: err.message || String(e), statusCode: err.statusCode });
      summary.failed += 1;
    }
  }
  return { ...(flags.dryRun && { dryRun: true as const }), ...listEnvelope(items), summary };
}

/** Extraction prompt template used by the AI cell extractor (GET /api/betomik-orderbook/extract-prompt). */
export async function runBetomikOrderbookExtractPrompt(client: ApiClient): Promise<unknown> {
  return client.get<unknown>("/api/betomik-orderbook/extract-prompt");
}

/** Blocked/exception rows of one sync run (GET /api/betomik-orderbook/runs/:runId/exceptions). */
export async function runBetomikOrderbookExceptions(
  client: ApiClient,
  runId: number
): Promise<ListEnvelope<Record<string, unknown>>> {
  const raw = await client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/exceptions`);
  return listEnvelope(itemsOf<Record<string, unknown>>(raw));
}

/** Sheet fleet vs vehicle table for one run (GET /api/betomik-orderbook/runs/:runId/fleet). */
export async function runBetomikOrderbookFleet(client: ApiClient, runId: number): Promise<unknown> {
  return client.get<unknown>(`/api/betomik-orderbook/runs/${runId}/fleet`);
}

export interface BetomikAuditRow {
  auditId: number;
  /** The ledger row whose sync created this entity — the join back to `rows`/`exceptions`. */
  importRowId: number | null;
  entity: string;
  entityId: number;
  label: string;
  createdAt: string;
  digestedAt: string | null;
}

/** Sync audit trail (entities written/digested), optionally since a given ISO timestamp (GET /api/betomik-orderbook/audit). */
export async function runBetomikOrderbookAudit(
  client: ApiClient,
  { since }: { since?: string }
): Promise<ListEnvelope<BetomikAuditRow>> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  const raw = await client.get<unknown>(`/api/betomik-orderbook/audit${qs}`);
  return listEnvelope(itemsOf<BetomikAuditRow>(raw));
}

/** One tick run's report, stored by the scheduled tick (POST /api/betomik-orderbook/tick-runs). */
export async function runBetomikOrderbookTickReport(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/tick-runs", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface BetomikTickRun {
  logCronJobId: number;
  entryTime: string;
  host?: string;
  isoYear?: number;
  isoWeek?: number;
  mode?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  failedStep?: string | null;
  steps?: { name: string; durationMs: number }[];
  sync?: Record<string, unknown> | null;
  /** The extractor's row counts; byProvider.bedrock = rows Bedrock served (the GX10 fallback when GX10 is configured, fb#1942). */
  extract?: { ok: number; failed: number; byProvider: Record<string, number> | null } | null;
  digestSent?: boolean;
  stepLines?: string[];
  errorTail?: string[] | null;
  /** The stored data did not parse; only logCronJobId/entryTime are present. */
  parseError?: true;
}

/** Recent tick runs, newest first (GET /api/betomik-orderbook/tick-runs). */
export async function runBetomikOrderbookTickRuns(
  client: ApiClient,
  { limit }: { limit?: number }
): Promise<ListEnvelope<BetomikTickRun>> {
  const qs = limit ? `?limit=${limit}` : "";
  const raw = await client.get<unknown>(`/api/betomik-orderbook/tick-runs${qs}`);
  return listEnvelope(itemsOf<BetomikTickRun>(raw));
}

export function registerBetomikOrderbookCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const group = parent
    .command("betomik-orderbook")
    .description("Betomik order-book import validator staging (developer only)");

  const importCmd = addJsonBodyOptions(group.command("import"));
  addWriteFlagsToCommand(importCmd).action(
    guarded(async (opts: WriteFlags & JsonBodyFlags) => {
      const body = resolveJsonBody(importCmd, opts, { required: true });
      const client = await getClient();
      const result = await runBetomikOrderbookImport(client, body as Record<string, unknown>, opts);
      writeJson(result);
    })
  );

  group
    .command("runs")
    .description("List import runs (sheet label, ISO year/week, row count), newest first")
    .option("--limit <n>", "Runs to return (client-side; the route is unpaged)", intFlag("--limit"))
    .option("--offset <n>", "Runs to skip", intFlag("--offset", 0))
    .action(
      jsonAction(getClient, (client, opts: { limit?: number; offset?: number }) =>
        runBetomikOrderbookRuns(client, opts)
      )
    );

  group
    .command("rows <runId>")
    .description("Staging rows of one import run (plate, driver, source type, m3, review status)")
    .option("--status <csv>", `Only rows whose syncStatus is one of: ${ROW_SYNC_STATUSES.join(", ")}`)
    .option("--limit <n>", "Rows to return after --status (client-side; the route is unpaged)", intFlag("--limit"))
    .option("--offset <n>", "Rows to skip after --status", intFlag("--offset", 0))
    .option("--no-raw", "Drop rawJson (the sheet cells) from every row — fits a context window")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: BetomikRowsFilter) =>
        runBetomikOrderbookRows(client, parseId(idStr, "runId"), opts)
      )
    );

  group
    .command("row <rowId>")
    .description("One staging row by id, whatever its syncStatus (incl. removed)")
    .option("--no-raw", "Drop rawJson (the sheet cells)")
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { raw?: boolean }) =>
        runBetomikOrderbookRow(client, parseId(idStr, "rowId"), opts)
      )
    );

  const reviewCmd = group
    .command("review <rowId>")
    .description("Review one staging row: set status, optionally override keikka/palkki + palkki type")
    .requiredOption("--status <status>", "pending | approved | rejected")
    .option("--row-kind <kind>", "keikka | palkki")
    .option("--palkki-type <name>", "one of the tenant's grid_palkkiTypes names")
    .option("--note <text>", "reviewNotes");
  addWriteFlagsToCommand(reviewCmd).action(
    guarded(
      async (
        idStr: string,
        opts: WriteFlags & { status: string; rowKind?: string; palkkiType?: string; note?: string }
      ) => {
        const client = await getClient();
        const body: BetomikReviewBody = { status: opts.status };
        if (opts.rowKind) body.rowKind = opts.rowKind;
        if (opts.palkkiType) body.palkkiType = opts.palkkiType;
        if (opts.note) body.notes = opts.note;
        writeJson(await runBetomikOrderbookReview(client, parseId(idStr, "rowId"), body, opts));
      }
    )
  );

  const proposeCmd = group
    .command("propose <runId>")
    .description("Run the AI proposer over one run (stores a proposal per row in aiJson)")
    .option("--provider <name>", "bedrock (default) | local")
    .option("--force", "Re-propose rows that already carry a proposal");
  addWriteFlagsToCommand(proposeCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & { provider?: string; force?: boolean }) => {
      const client = await getClient();
      const body: { provider?: string; force?: boolean } = {};
      if (opts.provider) body.provider = opts.provider;
      if (opts.force) body.force = true;
      writeJson(await runBetomikOrderbookPropose(client, parseId(idStr, "runId"), body, opts));
    })
  );

  group
    .command("ai-stats <runId>")
    .description("AI-vs-human agreement for one run's approved rows")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookAiStats(client, parseId(idStr, "runId"))
      )
    );

  group
    .command("sync-progress <runId>")
    .description("Where a running sync of one run is (rows done/total, then day drivers)")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookSyncProgress(client, parseId(idStr, "runId"))
      )
    );

  const syncCmd = addJsonBodyOptions(group.command("sync"))
    .option("--mode <mode>", "shadow (default) | create | full")
    .option("--provider <name>", "bedrock (default) | local")
    .option(
      "--digest",
      "Send the daily digest e-mail to the owner after the sync and stamp the included audit rows as digested — a real side effect, not a response field"
    );
  addWriteFlagsToCommand(syncCmd).action(
    guarded(
      async (
        opts: WriteFlags & JsonBodyFlags & { mode?: string; provider?: string; digest?: boolean }
      ) => {
        const jsonBody = resolveJsonBody(syncCmd, opts, { required: true });
        const body: Record<string, unknown> = {
          ...jsonBody,
          ...(opts.mode && { mode: opts.mode }),
          ...(opts.provider && { provider: opts.provider }),
          ...(opts.digest && { digest: true }),
        };
        const client = await getClient();
        writeJson(await runBetomikOrderbookSync(client, body, opts));
      }
    )
  );

  const resyncCmd = group
    .command("resync <runId>")
    .description("Re-run sync for an already-imported run without re-importing rows")
    .option("--mode <mode>", "shadow (default) | create | full")
    .option("--provider <name>", "bedrock (default) | local");
  addWriteFlagsToCommand(resyncCmd).action(
    guarded(async (idStr: string, opts: WriteFlags & { mode?: string; provider?: string }) => {
      const client = await getClient();
      const body: { mode?: string; provider?: string } = {};
      if (opts.mode) body.mode = opts.mode;
      if (opts.provider) body.provider = opts.provider;
      writeJson(await runBetomikOrderbookResync(client, parseId(idStr, "runId"), body, opts));
    })
  );

  const syncRowCmd = group
    .command("sync-row [rowId...]")
    .description("Write one or more ledger rows into betoni.online as keikka/palkki, one request per row (the validator's Vie betoni.onlineen)")
    .option("--run <runId>", "Instead of ids: every row of this run in --status", Number)
    .option("--status <csv>", `With --run: syncStatus values to take (default: ${DEFAULT_SYNC_ROW_STATUSES})`)
    .option("--provider <name>", "bedrock (default) | local — for rows with no stored extraction");
  addWriteFlagsToCommand(syncRowCmd).action(
    guarded(
      async (idStrs: string[], opts: WriteFlags & { run?: number; status?: string; provider?: string }) => {
        if (idStrs.length && opts.run != null) failWith("Pass row ids or --run <runId>, not both", 4);
        if (!idStrs.length && opts.run == null) failWith("Pass row ids or --run <runId>, not neither", 4);
        if (opts.run != null && (!Number.isInteger(opts.run) || opts.run < 1)) failWith("--run must be a positive integer", 4);
        const client = await getClient();
        const rowIds = opts.run != null ? await selectRowsToSync(client, opts.run, opts.status) : idStrs.map((s) => parseId(s, "rowId"));
        const body: { provider?: string } = {};
        if (opts.provider) body.provider = opts.provider;
        writeJson(await runBetomikOrderbookSyncRows(client, rowIds, body, opts));
      }
    )
  );

  group
    .command("extract-prompt")
    .description("Extraction prompt template used by the AI cell extractor (system, schema, cells, toolName)")
    .action(jsonAction(getClient, (client) => runBetomikOrderbookExtractPrompt(client)));

  group
    .command("exceptions <runId>")
    .description("Blocked/exception rows from one sync run")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookExceptions(client, parseId(idStr, "runId"))
      )
    );

  group
    .command("fleet <runId>")
    .description("Sheet fleet vs betoni.online vehicles for one import run (drift per vehicle, trucks not in the sheet)")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runBetomikOrderbookFleet(client, parseId(idStr, "runId"))
      )
    );

  group
    .command("audit")
    .description("Sync audit trail (entities written/digested), optionally since a given ISO timestamp")
    .option("--since <iso>", "Only rows created at/after this ISO timestamp")
    .action(
      jsonAction(getClient, (client, opts: { since?: string }) =>
        runBetomikOrderbookAudit(client, { since: opts.since })
      )
    );

  const tickReportCmd = addJsonBodyOptions(group.command("tick-report")).description(
    "Store one scheduled-tick run report (the tick script calls this from its EXIT trap; developer only)"
  );
  addWriteFlagsToCommand(tickReportCmd).action(
    guarded(async (opts: WriteFlags & JsonBodyFlags) => {
      const body = resolveJsonBody(tickReportCmd, opts, { required: true });
      const client = await getClient();
      writeJson(await runBetomikOrderbookTickReport(client, body as Record<string, unknown>, opts));
    })
  );

  group
    .command("tick-runs")
    .description("Recent scheduled-tick runs (start, duration, exit code, sync counts), newest first")
    .option("--limit <n>", "Rows to return (default 50, max 200)", intFlag("--limit"))
    .action(
      jsonAction(getClient, (client, opts: { limit?: number }) =>
        runBetomikOrderbookTickRuns(client, { limit: opts.limit })
      )
    );
}
