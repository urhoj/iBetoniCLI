import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
/**
 * Sentinel `jerryActiveUntil` value meaning "enrolled in BetoniJerry, no end
 * date" — matches the EditSijainti toggle (a future/sentinel datetime = active,
 * NULL = not enrolled). See sijainti.jerryActiveUntil in geoCodeSql.js.
 */
const JERRY_ACTIVE_SENTINEL = "9999-12-31 23:59:59";
/**
 * GET /api/cli/sijainti/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runSijaintiList(client, opts) {
    const params = new URLSearchParams();
    if (opts.type)
        params.set("type", opts.type);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    return client.get(`/api/cli/sijainti/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/geocode/sijainti/get/:sijaintiId — existing geocode route (not
 * /api/cli/) reused for v1.0 reads. Returns the flat backend record as-is.
 */
export async function runSijaintiGet(client, sijaintiId) {
    return client.get(`/api/geocode/sijainti/get/${sijaintiId}`);
}
/**
 * POST /api/geocode/sijainti/add with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal `X-Dry-Run` /
 * `Idempotency-Key` / `X-Action-Reason` headers.
 */
export async function runSijaintiCreate(client, body, flags) {
    return client.post("/api/geocode/sijainti/add", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /api/geocode/updateSijainti with a free-form body. The target
 * `sijaintiId` is carried IN the body (not the URL) — this matches the
 * existing geocodeRoutes.js shape.
 */
export async function runSijaintiUpdate(client, body, flags) {
    return client.post("/api/geocode/updateSijainti", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Toggle a varikko's BetoniJerry enrolment by writing `jerryActiveUntil`. There
 * is no partial-update route, so this replicates the EditSijainti save: GET the
 * current row, override `jerryActiveUntil` (sentinel = on, null = off), and POST
 * it back through /api/geocode/updateSijainti. `updateSijainti` whitelists the
 * persisted fields via extractSijaintiBody (lat/lng/placeId are untouched by
 * sijainti_save), so the round-trip preserves the rest of the row. `--dry-run`
 * is honoured server-side (the route returns `wouldUpdate` without persisting).
 */
export async function runSijaintiSetJerry(client, sijaintiId, on, flags) {
    const current = await client.get(`/api/geocode/sijainti/get/${sijaintiId}`);
    const body = {
        ...current,
        sijaintiId,
        jerryActiveUntil: on ? JERRY_ACTIVE_SENTINEL : null,
    };
    return client.post("/api/geocode/updateSijainti", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Register `ib sijainti` subcommands on the parent commander instance:
 *   - list    filterable by --type/--limit
 *   - get     single sijainti by id (uses existing /api/geocode/sijainti route)
 *   - create  POST /api/geocode/sijainti/add with --body JSON (write flags)
 *   - update  POST /api/geocode/updateSijainti with --body JSON (sijaintiId
 *             must be present IN the body; the route reads it from the body,
 *             not the URL)
 *
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerSijaintiCommands(parent, getClient) {
    const s = parent.command("sijainti").description("Sijainti (location) commands");
    s.command("list")
        .description("List sijainti (locations)")
        .option("--type <t>", "Filter by sijainti type")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runSijaintiList(client, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    s.command("get <sijaintiId>")
        .description("Get a single sijainti by sijaintiId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runSijaintiGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = s
        .command("create")
        .description("Create a new sijainti (POST /api/geocode/sijainti/add)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runSijaintiCreate(client, parsed, {
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
    const updateCmd = s
        .command("update")
        .description("Update a sijainti (POST /api/geocode/updateSijainti; sijaintiId is in the body)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body (must include sijaintiId)");
    addWriteFlagsToCommand(updateCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runSijaintiUpdate(client, parsed, {
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
    const setJerryCmd = s
        .command("set-jerry <sijaintiId>")
        .description("Enrol/unenrol a varikko in BetoniJerry by setting jerryActiveUntil (--on/--off)")
        .option("--on", "Enrol: jerryActiveUntil = sentinel (varikko receives Jerry requests)")
        .option("--off", "Unenrol: jerryActiveUntil = null");
    addWriteFlagsToCommand(setJerryCmd).action(async (idStr, opts) => {
        if (opts.on === opts.off) {
            // neither or both given — ambiguous
            writeError(new Error("Pass exactly one of --on / --off"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runSijaintiSetJerry(client, Number(idStr), !!opts.on, {
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