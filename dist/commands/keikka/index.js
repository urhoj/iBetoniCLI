import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { resolveDate } from "../../dates.js";
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
    return client.get(`/api/cli/keikka/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/keikka/get/:keikkaId. Returns the flat backend record as-is.
 */
export async function runKeikkaGet(client, keikkaId) {
    return client.get(`/api/cli/keikka/get/${keikkaId}`);
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
 *   - list     filterable by --from/--to/--customer/--vehicle/--status/--limit/--cursor
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
    const createCmd = k
        .command("create")
        .description("Create a new keikka (POST /api/keikka/newKeikka)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
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
        try {
            const client = await getClient();
            const fields = {};
            if (opts.status !== undefined)
                fields.status = opts.status;
            const result = await runKeikkaUpdate(client, Number(idStr), fields, {
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
}
//# sourceMappingURL=index.js.map