import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { resolveDate } from "../../dates.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { registerHistoryAlias } from "../changes/index.js";
// Re-exported for backward compatibility — resolveDate now lives in src/dates.ts.
export { resolveDate };
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
    return { ...envelope, range: { from: opts.from ?? null, to: opts.to ?? null } };
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
 * Update a keikka. v1.0 supports only `--status`; other fields are deferred
 * until the dedicated CLI mutation routes ship (v1.1). Calls the existing
 * `/api/keikka/setStatus` endpoint with the universal write-flag headers.
 */
export async function runKeikkaUpdate(client, keikkaId, fields, flags) {
    if (!("status" in fields)) {
        throw new Error("v1.0 only supports --status; other fields are pending v1.1");
    }
    return client.post("/api/keikka/setStatus", { keikkaId, tila: fields.status }, { headers: writeFlagsToHeaders(flags) });
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
    k.command("get <keikkaId>")
        .description("Get a single keikka by id")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runKeikkaGet(client, Number(idStr));
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
            const { ownerAsiakasId } = decodeJwtPayload(client.getCurrentToken());
            const result = await runKeikkaSearch(client, query, ownerAsiakasId, opts.limit);
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
        .option("--status <s>", "New status (forwarded as `tila`)");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        if (opts.status === undefined) {
            failWith("Nothing to update: pass --status (v1.0 supports --status only)", 4);
        }
        try {
            const client = await getClient();
            const result = await runKeikkaUpdate(client, Number(idStr), { status: opts.status }, {
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
            const result = await runKeikkaDriversAssign(client, Number(idStr), {
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
    registerHistoryAlias(k, getClient, "keikka", "keikkaId", "Change-tracker audit trail for one keikka (folds in its keikkaBetoni rows). Alias of `ib changes entity keikka`.", "Filter by changeTracker fieldName (e.g. kuskit, laskuMemo)");
}
//# sourceMappingURL=index.js.map