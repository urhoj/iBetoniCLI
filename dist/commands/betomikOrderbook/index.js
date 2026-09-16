import { writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { addJsonBodyOptions, resolveJsonBody } from "../_shared/jsonBody.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { writeJson, failWith } from "../../output/json.js";
import { listEnvelope } from "../../api/envelopes.js";
import { parseId, intFlag } from "../../targets.js";
export async function runBetomikOrderbookImport(client, body, flags) {
    return client.post("/api/betomik-orderbook/import", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
function itemsOf(raw) {
    const items = raw?.items;
    return Array.isArray(items) ? items : [];
}
/** Import runs for the Betomik staging table, newest first (GET /api/betomik-orderbook/runs). */
export async function runBetomikOrderbookRuns(client) {
    const raw = await client.get("/api/betomik-orderbook/runs");
    return listEnvelope(itemsOf(raw));
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
export async function runBetomikOrderbookRows(client, runId, filter = {}) {
    const wanted = (filter.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = wanted.filter((s) => !ROW_SYNC_STATUSES.includes(s));
    if (bad.length) {
        failWith(`--status: unknown value${bad.length > 1 ? "s" : ""} ${bad.join(", ")} — accepted: ${ROW_SYNC_STATUSES.join(", ")}`, 4, bad.includes("removed") ? "removed rows are excluded by the route itself (fb#1722) and cannot be listed" : undefined);
    }
    const raw = await client.get(`/api/betomik-orderbook/runs/${runId}/rows`);
    let items = itemsOf(raw);
    if (wanted.length)
        items = items.filter((r) => wanted.includes(String(r.syncStatus)));
    if (filter.raw === false)
        items = items.map(({ rawJson: _raw, ...rest }) => rest);
    if (filter.limit === undefined && filter.offset === undefined)
        return listEnvelope(items);
    const offset = filter.offset ?? 0;
    const end = filter.limit === undefined ? items.length : offset + filter.limit;
    const truncated = end < items.length;
    return listEnvelope(items.slice(offset, end), {
        truncated,
        ...(truncated ? { hint: `${items.length - end} more row(s) — re-run with --offset ${end}` } : {}),
    });
}
/** Review one staging row (POST /api/betomik-orderbook/rows/:rowId/review). */
export async function runBetomikOrderbookReview(client, rowId, body, flags) {
    return client.post(`/api/betomik-orderbook/rows/${rowId}/review`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Run the AI proposer over one run (POST /api/betomik-orderbook/runs/:runId/propose). */
export async function runBetomikOrderbookPropose(client, runId, body, flags) {
    return client.post(`/api/betomik-orderbook/runs/${runId}/propose`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** AI-vs-human agreement for one run (GET /api/betomik-orderbook/runs/:runId/ai-stats). */
export async function runBetomikOrderbookAiStats(client, runId) {
    return client.get(`/api/betomik-orderbook/runs/${runId}/ai-stats`);
}
/** Progress of a running sync (GET /api/betomik-orderbook/runs/:runId/sync-progress). */
export async function runBetomikOrderbookSyncProgress(client, runId) {
    return client.get(`/api/betomik-orderbook/runs/${runId}/sync-progress`);
}
/** Sync a Betomik order-book payload to keikka/palkki rows (POST /api/betomik-orderbook/sync). */
export async function runBetomikOrderbookSync(client, body, flags) {
    return client.post("/api/betomik-orderbook/sync", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Re-run sync for an already-imported run (POST /api/betomik-orderbook/runs/:runId/sync). */
export async function runBetomikOrderbookResync(client, runId, body, flags) {
    return client.post(`/api/betomik-orderbook/runs/${runId}/sync`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
const DEFAULT_SYNC_ROW_STATUSES = "pending,blocked,gone";
/** The ledger rows of one run in the given statuses (default: the ones a sync would still act on), by id. */
export async function selectRowsToSync(client, runId, statuses) {
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
export async function runBetomikOrderbookSyncRows(client, rowIds, body, flags) {
    const items = [];
    const summary = { rows: rowIds.length, synced: 0, blocked: 0, removed: 0, pending: 0, failed: 0 };
    for (const rowId of rowIds) {
        const perRow = flags.idempotencyKey ? { ...flags, idempotencyKey: `${flags.idempotencyKey}:${rowId}` } : flags;
        try {
            const res = (await client.post(`/api/betomik-orderbook/rows/${rowId}/sync`, body, {
                headers: writeFlagsToHeaders(perRow),
            }));
            const row = res.row || {};
            const status = String(row.syncStatus ?? "");
            items.push({
                rowId,
                ok: true,
                syncStatus: status,
                plannedAction: row.plannedAction,
                rowKind: row.rowKind,
                palkkiType: row.palkkiType ?? null,
                keikkaId: row.keikkaId ?? null,
                palkkiId: row.palkkiId ?? null,
                blockReason: row.blockReason ?? null,
                written: res.summary?.written,
                errors: res.summary?.errors ?? [],
            });
            if (status === "synced" || status === "blocked" || status === "removed" || status === "pending")
                summary[status] += 1;
        }
        catch (e) {
            const err = e;
            items.push({ rowId, ok: false, error: err.message || String(e), statusCode: err.statusCode });
            summary.failed += 1;
        }
    }
    return { ...(flags.dryRun && { dryRun: true }), ...listEnvelope(items), summary };
}
/** Extraction prompt template used by the AI cell extractor (GET /api/betomik-orderbook/extract-prompt). */
export async function runBetomikOrderbookExtractPrompt(client) {
    return client.get("/api/betomik-orderbook/extract-prompt");
}
/** Blocked/exception rows of one sync run (GET /api/betomik-orderbook/runs/:runId/exceptions). */
export async function runBetomikOrderbookExceptions(client, runId) {
    const raw = await client.get(`/api/betomik-orderbook/runs/${runId}/exceptions`);
    return listEnvelope(itemsOf(raw));
}
/** Sheet fleet vs vehicle table for one run (GET /api/betomik-orderbook/runs/:runId/fleet). */
export async function runBetomikOrderbookFleet(client, runId) {
    return client.get(`/api/betomik-orderbook/runs/${runId}/fleet`);
}
/** Sync audit trail (entities written/digested), optionally since a given ISO timestamp (GET /api/betomik-orderbook/audit). */
export async function runBetomikOrderbookAudit(client, { since }) {
    const qs = since ? `?since=${encodeURIComponent(since)}` : "";
    const raw = await client.get(`/api/betomik-orderbook/audit${qs}`);
    return listEnvelope(itemsOf(raw));
}
export function registerBetomikOrderbookCommands(parent, getClient) {
    const group = parent
        .command("betomik-orderbook")
        .description("Betomik order-book import validator staging (developer only)");
    const importCmd = addJsonBodyOptions(group.command("import"));
    addWriteFlagsToCommand(importCmd).action(guarded(async (opts) => {
        const body = resolveJsonBody(importCmd, opts, { required: true });
        const client = await getClient();
        const result = await runBetomikOrderbookImport(client, body, opts);
        writeJson(result);
    }));
    group
        .command("runs")
        .description("List import runs (sheet label, ISO year/week, row count), newest first")
        .action(jsonAction(getClient, (client) => runBetomikOrderbookRuns(client)));
    group
        .command("rows <runId>")
        .description("Staging rows of one import run (plate, driver, source type, m3, review status)")
        .option("--status <csv>", `Only rows whose syncStatus is one of: ${ROW_SYNC_STATUSES.join(", ")}`)
        .option("--limit <n>", "Rows to return after --status (client-side; the route is unpaged)", intFlag("--limit"))
        .option("--offset <n>", "Rows to skip after --status", intFlag("--offset", 0))
        .option("--no-raw", "Drop rawJson (the sheet cells) from every row — fits a context window")
        .action(jsonAction(getClient, (client, idStr, opts) => runBetomikOrderbookRows(client, parseId(idStr, "runId"), opts)));
    const reviewCmd = group
        .command("review <rowId>")
        .description("Review one staging row: set status, optionally override keikka/palkki + palkki type")
        .requiredOption("--status <status>", "pending | approved | rejected")
        .option("--row-kind <kind>", "keikka | palkki")
        .option("--palkki-type <name>", "one of the tenant's grid_palkkiTypes names")
        .option("--note <text>", "reviewNotes");
    addWriteFlagsToCommand(reviewCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = { status: opts.status };
        if (opts.rowKind)
            body.rowKind = opts.rowKind;
        if (opts.palkkiType)
            body.palkkiType = opts.palkkiType;
        if (opts.note)
            body.notes = opts.note;
        writeJson(await runBetomikOrderbookReview(client, parseId(idStr, "rowId"), body, opts));
    }));
    const proposeCmd = group
        .command("propose <runId>")
        .description("Run the AI proposer over one run (stores a proposal per row in aiJson)")
        .option("--provider <name>", "bedrock (default) | local")
        .option("--force", "Re-propose rows that already carry a proposal");
    addWriteFlagsToCommand(proposeCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = {};
        if (opts.provider)
            body.provider = opts.provider;
        if (opts.force)
            body.force = true;
        writeJson(await runBetomikOrderbookPropose(client, parseId(idStr, "runId"), body, opts));
    }));
    group
        .command("ai-stats <runId>")
        .description("AI-vs-human agreement for one run's approved rows")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookAiStats(client, parseId(idStr, "runId"))));
    group
        .command("sync-progress <runId>")
        .description("Where a running sync of one run is (rows done/total, then day drivers)")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookSyncProgress(client, parseId(idStr, "runId"))));
    const syncCmd = addJsonBodyOptions(group.command("sync"))
        .option("--mode <mode>", "shadow (default) | create | full")
        .option("--provider <name>", "bedrock (default) | local")
        .option("--digest", "Send the daily digest e-mail to the owner after the sync and stamp the included audit rows as digested — a real side effect, not a response field");
    addWriteFlagsToCommand(syncCmd).action(guarded(async (opts) => {
        const jsonBody = resolveJsonBody(syncCmd, opts, { required: true });
        const body = {
            ...jsonBody,
            ...(opts.mode && { mode: opts.mode }),
            ...(opts.provider && { provider: opts.provider }),
            ...(opts.digest && { digest: true }),
        };
        const client = await getClient();
        writeJson(await runBetomikOrderbookSync(client, body, opts));
    }));
    const resyncCmd = group
        .command("resync <runId>")
        .description("Re-run sync for an already-imported run without re-importing rows")
        .option("--mode <mode>", "shadow (default) | create | full")
        .option("--provider <name>", "bedrock (default) | local");
    addWriteFlagsToCommand(resyncCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = {};
        if (opts.mode)
            body.mode = opts.mode;
        if (opts.provider)
            body.provider = opts.provider;
        writeJson(await runBetomikOrderbookResync(client, parseId(idStr, "runId"), body, opts));
    }));
    const syncRowCmd = group
        .command("sync-row [rowId...]")
        .description("Write one or more ledger rows into betoni.online as keikka/palkki, one request per row (the validator's Vie betoni.onlineen)")
        .option("--run <runId>", "Instead of ids: every row of this run in --status", Number)
        .option("--status <csv>", `With --run: syncStatus values to take (default: ${DEFAULT_SYNC_ROW_STATUSES})`)
        .option("--provider <name>", "bedrock (default) | local — for rows with no stored extraction");
    addWriteFlagsToCommand(syncRowCmd).action(guarded(async (idStrs, opts) => {
        if (idStrs.length && opts.run != null)
            failWith("Pass row ids or --run <runId>, not both", 4);
        if (!idStrs.length && opts.run == null)
            failWith("Pass row ids or --run <runId>, not neither", 4);
        if (opts.run != null && (!Number.isInteger(opts.run) || opts.run < 1))
            failWith("--run must be a positive integer", 4);
        const client = await getClient();
        const rowIds = opts.run != null ? await selectRowsToSync(client, opts.run, opts.status) : idStrs.map((s) => parseId(s, "rowId"));
        const body = {};
        if (opts.provider)
            body.provider = opts.provider;
        writeJson(await runBetomikOrderbookSyncRows(client, rowIds, body, opts));
    }));
    group
        .command("extract-prompt")
        .description("Extraction prompt template used by the AI cell extractor (system, schema, cells, toolName)")
        .action(jsonAction(getClient, (client) => runBetomikOrderbookExtractPrompt(client)));
    group
        .command("exceptions <runId>")
        .description("Blocked/exception rows from one sync run")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookExceptions(client, parseId(idStr, "runId"))));
    group
        .command("fleet <runId>")
        .description("Sheet fleet vs betoni.online vehicles for one import run (drift per vehicle, trucks not in the sheet)")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookFleet(client, parseId(idStr, "runId"))));
    group
        .command("audit")
        .description("Sync audit trail (entities written/digested), optionally since a given ISO timestamp")
        .option("--since <iso>", "Only rows created at/after this ISO timestamp")
        .action(jsonAction(getClient, (client, opts) => runBetomikOrderbookAudit(client, { since: opts.since })));
}
//# sourceMappingURL=index.js.map