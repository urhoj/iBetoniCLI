import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { resolveDate, todayHelsinki, addDaysISO } from "../../dates.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { registerLogAlias } from "../log/index.js";
import { parseId } from "../../targets.js";
// Re-exported for backward compatibility — resolveDate now lives in src/dates.ts.
export { resolveDate };
/**
 * Build the count:0 disambiguation hint (feedback #165). An AI seeing an empty
 * list can't tell "no access" from "no data" from "date-filtered"; this spells
 * it out: 0 rows on a 200/exit-0 is a PERMITTED-but-empty result (access denial
 * is exit 3 / HTTP 403), names the searched window, flags the today-only default,
 * and points at the two ways to see more (widen --from/--to, or `ib keikka latest`
 * for the most recent match regardless of date).
 */
function zeroRowHint(range, opts) {
    const window = range.from && range.to
        ? range.from === range.to
            ? range.from
            : `${range.from}..${range.to}`
        : "the requested window";
    const today = todayHelsinki();
    const scopedToToday = range.from === today && range.to === today;
    const hasFilters = opts.customer !== undefined ||
        opts.vehicle !== undefined ||
        opts.worksite !== undefined ||
        opts.status !== undefined;
    return (`0 rows: no keikka in ${window}${hasFilters ? " matching the given filters" : ""}. ` +
        `A 0 count on a successful (exit 0) query means no data in this window, NOT an access error ` +
        `(denied access surfaces as exit 3 / HTTP 403). ` +
        (scopedToToday ? "The default window is TODAY only. " : "") +
        "Widen the range with --from/--to, or run `ib keikka latest` to fetch the most recent " +
        "keikka regardless of date.");
}
/**
 * GET /api/cli/keikka/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runKeikkaList(client, opts) {
    const params = new URLSearchParams();
    if (opts.from)
        params.set("from", opts.from);
    if (opts.to)
        params.set("to", opts.to);
    if (opts.customer !== undefined)
        params.set("customer", String(opts.customer));
    if (opts.vehicle !== undefined)
        params.set("vehicle", String(opts.vehicle));
    if (opts.worksite !== undefined)
        params.set("worksite", String(opts.worksite));
    if (opts.status)
        params.set("status", opts.status);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.cursor)
        params.set("cursor", opts.cursor);
    const qs = params.toString();
    const envelope = await client.get(`/api/cli/keikka/list${qs ? `?${qs}` : ""}`);
    // Echo the interpreted date window so a count:0 result is self-evidently
    // scoped — without it an empty list is indistinguishable from a mis-aimed query.
    const range = { from: opts.from ?? null, to: opts.to ?? null };
    // On an empty result add the "why zero rows" hint so an AI reader doesn't
    // mistake permitted-but-empty for an access block (feedback #165).
    return envelope.count === 0
        ? { ...envelope, range, hint: zeroRowHint(range, opts) }
        : { ...envelope, range };
}
/** Window sizes (days) walked backwards from today; the last size repeats until --lookback is covered. */
const LATEST_WINDOW_DAYS = [7, 30, 90, 365];
/** Whole days between two ISO dates (a ≤ b). */
function daysBetween(a, b) {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
/** Newest row first: order by pvm, then time (ISO strings compare lexically). */
function newestFirst(a, b) {
    return (String(b.pvm ?? "").localeCompare(String(a.pvm ?? "")) ||
        String(b.time ?? "").localeCompare(String(a.time ?? "")));
}
/**
 * "Latest keikka matching the filters" WITHOUT a mandatory date range
 * (feedback #26: one-step answers to "when was the last delivered order?").
 *
 * Entirely client-side over the existing `/api/cli/keikka/list` window query —
 * no backend change, no deploy gate. Walks contiguous windows backwards from
 * today (7 → 30 → 90 → 365-day spans, the last repeating) until a window has
 * matches or `--lookback` (default 365 days) is exhausted; the newest row of
 * the first non-empty window is the answer. Worst case = a handful of
 * round-trips. When a window comes back truncated at the 500-row server cap
 * (order not guaranteed), it is repeatedly halved toward its NEWEST end so
 * the true latest row cannot be hidden by truncation.
 */
export async function runKeikkaLatest(client, opts) {
    const today = todayHelsinki();
    const lookback = Math.min(Math.max(opts.lookback ?? 365, 1), 3650);
    const earliest = addDaysISO(today, -(lookback - 1));
    const base = {
        status: opts.status,
        customer: opts.customer,
        vehicle: opts.vehicle,
        worksite: opts.worksite,
        limit: 500,
    };
    let to = today;
    let windowIdx = 0;
    while (to >= earliest) {
        const span = LATEST_WINDOW_DAYS[Math.min(windowIdx, LATEST_WINDOW_DAYS.length - 1)];
        windowIdx++;
        let from = addDaysISO(to, -(span - 1));
        if (from < earliest)
            from = earliest;
        let env = await runKeikkaList(client, { ...base, from, to });
        // Truncated at the server cap → halve toward the newest end until the
        // window fits (or is a single day, which we accept as-is).
        while (env.count >= 500 && from < to) {
            from = addDaysISO(to, -Math.floor(daysBetween(from, to) / 2));
            env = await runKeikkaList(client, { ...base, from, to });
        }
        if (env.count > 0) {
            const newest = [...env.items].sort(newestFirst)[0];
            return { item: newest, searched: { from, to: today } };
        }
        to = addDaysISO(from, -1);
    }
    return { item: null, searched: { from: earliest, to: today } };
}
/**
 * GET /api/cli/keikka/get/:keikkaId. Returns the flat backend record as-is.
 */
export async function runKeikkaGet(client, keikkaId) {
    return client.get(`/api/cli/keikka/get/${keikkaId}`);
}
/**
 * GET /api/keikka/search — existing deployed route (used by the GPT order
 * tool). NOTE: ownerAsiakasId comes from the QUERY STRING (no JWT fallback on
 * this route) — callers supply it from the active token via decodeJwtPayload.
 * usingFullTextSearch=true mirrors the GPT tool's default path. Rows arrive
 * one-per-keikkaBetoni; dedupe by keikkaId. `limit` is applied client-side
 * (the backend caps at TOP 100, no limit param).
 */
export async function runKeikkaSearch(client, query, ownerAsiakasId, limit) {
    const qs = new URLSearchParams({
        searchString: query,
        ownerAsiakasId: String(ownerAsiakasId),
        usingFullTextSearch: "true",
    });
    const rows = await client.get(`/api/keikka/search?${qs.toString()}`);
    const seen = new Map();
    for (const r of rows || []) {
        const id = Number(r.keikkaId);
        if (seen.has(id))
            continue;
        seen.set(id, {
            keikkaId: id,
            title: r.keikkaOtsikko ?? null,
            pumppuAika: r.pumppuAika != null ? String(r.pumppuAika) : null,
            customerName: r.asiakasNimi ?? null,
            worksiteName: r.tyomaaNimi ?? null,
            address: r.osoite ?? null,
            contactPerson: r.contactPerson ?? null,
            contactPhone: r.contactPhone ?? null,
        });
    }
    const items = [...seen.values()].slice(0, limit ?? seen.size);
    return { items, nextCursor: null, count: items.length };
}
/**
 * POST /api/keikka/newKeikka with a free-form body forwarded to the existing
 * BE endpoint. Write flags are surfaced as `X-Dry-Run`, `Idempotency-Key`,
 * and `X-Action-Reason` headers.
 */
export async function runKeikkaCreate(client, body, flags) {
    return client.post("/api/keikka/newKeikka", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Update a keikka. v1.0 supports only `--status` (the lifecycle keikkaTilaId);
 * other fields are deferred until the dedicated CLI mutation routes ship (v1.1).
 * Posts the numeric keikkaTilaId to `/api/keikka/tila/set` with the universal
 * write-flag headers.
 */
export async function runKeikkaUpdate(client, keikkaId, fields, flags) {
    if (!("status" in fields)) {
        throw new Error("v1.0 only supports --status; other fields are pending v1.1");
    }
    // --status is a keikkaTilaId and MUST go to /api/keikka/tila/set as
    // `keikkaTilaId`. The older /setStatus endpoint ignores a `tila` field (it
    // saves per-section completion flags), so posting there silently no-ops the
    // lifecycle-state change.
    const keikkaTilaId = Number(fields.status);
    if (!Number.isInteger(keikkaTilaId)) {
        failWith(`--status must be a numeric keikkaTilaId (e.g. 9 = Toimitettu); got "${String(fields.status)}"`, 4);
    }
    return client.post("/api/keikka/tila/set", { keikkaId, keikkaTilaId }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/keikka/defaultDriver/assign/:keikkaId with an empty body. The
 * backend uses the JWT/keikka context to pick the appropriate default
 * driver; the CLI just forwards write flags.
 */
export async function runKeikkaDriversAssign(client, keikkaId, flags) {
    return client.post(`/api/keikka/defaultDriver/assign/${keikkaId}`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/cli/keikka/validate/:keikkaId (single) or
 * GET /api/cli/keikka/validate?date=YYYY-MM-DD (day).
 */
export async function runKeikkaValidate(client, opts) {
    if (opts.date) {
        return client.get(`/api/cli/keikka/validate?date=${encodeURIComponent(opts.date)}`);
    }
    if (opts.keikkaId != null) {
        return client.get(`/api/cli/keikka/validate/${opts.keikkaId}`);
    }
    return failWith("Pass a keikkaId or --date <YYYY-MM-DD>", 4);
}
/**
 * Register `ib keikka` subcommands on the parent commander instance:
 *   - list     filterable by --from/--to/--customer/--vehicle/--worksite/--status/--limit/--cursor
 *   - get      single keikka by id
 *   - create   POST /api/keikka/newKeikka with --body JSON (write flags)
 *   - update   POST /api/keikka/setStatus (v1.0: --status only)
 *   - drivers  drivers assign <keikkaId> → POST default-driver assignment
 *
 * Date aliases (today/yesterday/tomorrow) are resolved before the API call.
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerKeikkaCommands(parent, getClient) {
    const k = parent.command("keikka").description("Keikka commands");
    k.command("list")
        .description("List keikkas matching the filters")
        .option("--from <date>", "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .option("--to <date>", "End date YYYY-MM-DD (or today/yesterday/tomorrow)", "today")
        .option("--customer <id>", "Filter by asiakasId", (v) => Number(v))
        .option("--vehicle <id>", "Filter by vehicleId", (v) => Number(v))
        .option("--worksite <id>", "Filter by worksite (tyomaaId)", (v) => Number(v))
        .option("--status <s>", "Filter by status")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .option("--cursor <c>", "Pagination cursor")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const resolved = {
                ...opts,
                from: resolveDate(opts.from),
                to: resolveDate(opts.to),
            };
            const result = await runKeikkaList(client, resolved);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    k.command("latest")
        .description("Latest keikka matching the filters — searches backwards from today, no date range needed")
        .option("--status <s>", "Filter by status (keikkaTilaId, e.g. 9 = Toimitettu)")
        .option("--customer <id>", "Filter by asiakasId", (v) => Number(v))
        .option("--vehicle <id>", "Filter by vehicleId", (v) => Number(v))
        .option("--worksite <id>", "Filter by worksite (tyomaaId)", (v) => Number(v))
        .option("--lookback <days>", "How far back from today to search (default 365, max 3650)", (v) => Number(v))
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runKeikkaLatest(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    k.command("get <keikkaId>")
        .description("Get a single keikka by id")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runKeikkaGet(client, parseId(idStr, "keikkaId"));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    k.command("search <query>")
        .description("Search keikkas (full-text: phone, keikkaId, worksite name/number, invoice ref)")
        .option("--limit <n>", "Max hits (client-side; backend caps at 100)", (v) => Number(v))
        .action(async (query, opts) => {
        try {
            const client = await getClient();
            const ownerAsiakasId = decodeJwtPayload(client.getCurrentToken()).ownerAsiakasId ??
                failWith("could not resolve ownerAsiakasId from the active token", 4);
            const result = await runKeikkaSearch(client, query, ownerAsiakasId, opts.limit);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    k.command("validate [keikkaId]")
        .description("Validate a keikka (or a whole day with --date) against the reminders-drawer rules")
        .option("--date <date>", "Validate every keikka for this date (YYYY-MM-DD or today/yesterday/tomorrow)")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            if (opts.date && idStr) {
                failWith("Pass either a keikkaId or --date, not both", 4);
            }
            const result = await runKeikkaValidate(client, {
                keikkaId: idStr ? parseId(idStr, "keikkaId") : undefined,
                date: opts.date ? resolveDate(opts.date) : undefined,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = k
        .command("create")
        .description("Create a new keikka (POST /api/keikka/newKeikka)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = parseJsonBodyFlag(opts.body);
            const result = await runKeikkaCreate(client, parsed, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = k
        .command("update <keikkaId>")
        .description("Update a keikka (v1.0: --status only)")
        .option("--status <s>", "New keikkaTilaId (numeric, e.g. 9 = Toimitettu)");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        if (opts.status === undefined) {
            failWith("Nothing to update: pass --status (v1.0 supports --status only)", 4);
        }
        try {
            const client = await getClient();
            const result = await runKeikkaUpdate(client, parseId(idStr, "keikkaId"), { status: opts.status }, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const drivers = k.command("drivers").description("Driver assignment commands");
    const assignCmd = drivers
        .command("assign <keikkaId>")
        .description("Assign the default driver to a keikka");
    addWriteFlagsToCommand(assignCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const result = await runKeikkaDriversAssign(client, parseId(idStr, "keikkaId"), {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    registerLogAlias(k, getClient, "keikka", "keikkaId", "Change-tracker audit trail for one keikka (folds in its keikkaBetoni rows). Alias of `ib log entity keikka`.", "Filter by changeTracker fieldName (e.g. kuskit, laskuMemo)");
}
//# sourceMappingURL=index.js.map