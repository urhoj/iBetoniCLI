import { createRequire } from "node:module";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { resolveRoleTypeId } from "../../roles.js";
/**
 * GET /api/cli/customer/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runCustomerList(client, opts) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.cursor)
        params.set("cursor", opts.cursor);
    const qs = params.toString();
    return client.get(`/api/cli/customer/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/customer/get/:asiakasId. Returns the flat backend record as-is.
 */
export async function runCustomerGet(client, asiakasId) {
    return client.get(`/api/cli/customer/get/${asiakasId}`);
}
/**
 * GET /api/cli/customer/modules/:asiakasId — report roolit booleans + the 8
 * module flags the CLI exposes. Read-only; admin-gated server-side (system
 * admin may read any tenant). Returns the backend shape verbatim.
 */
export async function runCustomerModulesReport(client, asiakasId) {
    return client.get(`/api/cli/customer/modules/${asiakasId}`);
}
/** asiakasSettings-backed module field keys (excludes the roolit-backed `pumppu`). */
export const MODULE_FIELD_KEYS = [
    "jerry",
    "henkilot",
    "sijainnit",
    "ajoneuvot",
    "tiedostot",
    "weather",
    "lomaseuranta",
    "shareorders",
];
/** Every togglable field key: the 8 modules plus `pumppu` (isPumppuToimittaja). */
export const ALL_FIELD_KEYS = ["pumppu", ...MODULE_FIELD_KEYS];
/**
 * Map each module field key to its asiakasSettingTypeId, sourced at call time
 * from ASIAKAS_SETTING_TYPE_IDS in @ibetoni/constants (the single source of
 * truth). `pumppu` is intentionally absent — it is a roolit column, not a
 * setting.
 */
function moduleKeyToTypeId() {
    const constants = cjsRequire("@ibetoni/constants");
    const ids = constants.ASIAKAS_SETTING_TYPE_IDS;
    return {
        jerry: ids.HAS_JERRY,
        henkilot: ids.HAS_HENKILOT,
        sijainnit: ids.HAS_SIJAINNIT,
        ajoneuvot: ids.HAS_AJONEUVOT,
        tiedostot: ids.HAS_TIEDOSTOT,
        weather: ids.HAS_WEATHER,
        lomaseuranta: ids.LOMASEURANTA,
        shareorders: ids.SHARE_ORDERS_WITH_BETONI,
    };
}
/**
 * Parse --set / --unset comma-separated field lists into a desired-state map
 * (key -> boolean). Validates each key against ALL_FIELD_KEYS and rejects a
 * key requested both ON and OFF. Throws (caller exits 4) on bad input.
 */
export function parseModuleChanges(setCsv, unsetCsv) {
    const changes = new Map();
    const valid = new Set(ALL_FIELD_KEYS);
    const apply = (csv, value) => {
        if (!csv)
            return;
        for (const raw of csv.split(",")) {
            const key = raw.trim().toLowerCase();
            if (!key)
                continue;
            if (!valid.has(key)) {
                throw new Error(`unknown field: ${key}. Valid: ${ALL_FIELD_KEYS.join(", ")}`);
            }
            if (changes.has(key) && changes.get(key) !== value) {
                throw new Error(`field '${key}' given to both --set and --unset`);
            }
            changes.set(key, value);
        }
    };
    apply(setCsv, true);
    apply(unsetCsv, false);
    if (changes.size === 0) {
        throw new Error("no fields given — pass --set and/or --unset");
    }
    return changes;
}
/**
 * Apply a desired-state map to one customer. `pumppu` routes to
 * POST /api/asiakas/setRoolit (echoing the other three roolit booleans
 * unchanged); module keys batch into POST /api/asiakas/settings/save with
 * laskuttajaAsiakasId = asiakasId (self-billing) and asiakasSettingId null
 * (upsert). Re-fetches and returns the resulting state. Both writes are
 * admin-gated server-side; --dry-run / --reason / --idempotency-key flow
 * through as the universal headers.
 */
export async function runCustomerModulesApply(client, asiakasId, changes, flags) {
    const headers = writeFlagsToHeaders(flags);
    // Roolit preservation: setRoolit overwrites all four columns, so read the
    // current quad first and echo back the three we are not changing.
    if (changes.has("pumppu")) {
        const current = await runCustomerModulesReport(client, asiakasId);
        const r = current.roolit;
        await client.post("/api/asiakas/setRoolit", {
            asiakasId,
            isTyomaaAsiakas: r.isTyomaaAsiakas,
            isPumppuToimittaja: changes.get("pumppu"),
            isBetoniToimittaja: r.isBetoniToimittaja,
            isLattiaToimittaja: r.isLattiaToimittaja,
        }, { headers });
    }
    const typeIds = moduleKeyToTypeId();
    const settings = [...changes.entries()]
        .filter(([key]) => key !== "pumppu")
        .map(([key, value]) => ({
        asiakasSettingId: null,
        asiakasId,
        laskuttajaAsiakasId: asiakasId,
        asiakasSettingTypeId: typeIds[key],
        asiakasSettingBool: value,
    }));
    if (settings.length > 0) {
        await client.post("/api/asiakas/settings/save", settings, { headers });
    }
    const state = await runCustomerModulesReport(client, asiakasId);
    return {
        asiakasId,
        applied: {
            set: [...changes].filter(([, v]) => v).map(([k]) => k),
            unset: [...changes].filter(([, v]) => !v).map(([k]) => k),
            dryRun: !!flags.dryRun,
        },
        state,
    };
}
/**
 * Build the operator-preset desired-state map: every one of the 9 fields set
 * to `value`. Used by `ib customer operator --set` (true) / `--reset` (false).
 */
export function operatorPresetChanges(value) {
    return new Map(ALL_FIELD_KEYS.map((k) => [k, value]));
}
/**
 * Verify the operator preset for one customer: reads the modules report and
 * checks all 9 operator fields are ON (pumppu via roolit.isPumppuToimittaja,
 * the 8 modules via their flags). Pure read — the caller maps `allSet` to the
 * process exit code (0 when fully provisioned, 1 otherwise).
 */
export async function runCustomerOperatorVerify(client, asiakasId) {
    const state = await runCustomerModulesReport(client, asiakasId);
    const flags = {
        pumppu: state.roolit.isPumppuToimittaja,
    };
    for (const key of MODULE_FIELD_KEYS)
        flags[key] = !!state.modules[key];
    const missing = ALL_FIELD_KEYS.filter((k) => !flags[k]);
    return { asiakasId, allSet: missing.length === 0, flags, missing };
}
/**
 * GET /api/tyomaa/asiakasTyomaaList/:asiakasId — worksites belonging to a
 * customer. Backend returns a raw array; wrapped into the universal envelope.
 */
export async function runCustomerWorksites(client, asiakasId) {
    const rows = await client.get(`/api/tyomaa/asiakasTyomaaList/${asiakasId}`);
    const items = (rows || []).map((r) => ({
        tyomaaId: r.tyomaaId,
        name: r.tyomaaNimi || null,
        address: r.tyomaaOsoite1 || null,
        city: r.tyomaaOsoite4 || null,
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * GET /api/asiakas/search?searchString=<query> — existing (non-/api/cli/) route
 * used by the FE customer typeahead. The backend scopes results to the caller's
 * company (req.user.ownerAsiakasId) when no ownerAsiakasId query param is given,
 * so the CLI sends only searchString. Result shape is whatever the backend
 * returns (typically an array of asiakas records).
 */
export async function runCustomerSearch(client, query) {
    const qs = new URLSearchParams({ searchString: query }).toString();
    return client.get(`/api/asiakas/search?${qs}`);
}
/**
 * POST /api/asiakas/createY with a free-form body forwarded to the existing
 * BE endpoint (FE: `asiakas_createY()`). Write flags are surfaced as
 * `X-Dry-Run`, `Idempotency-Key`, and `X-Action-Reason` headers.
 */
export async function runCustomerCreate(client, body, flags) {
    return client.post("/api/asiakas/createY", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * POST /api/asiakas/set/:asiakasId with a free-form body forwarded to the
 * existing BE endpoint. Write flags surface as the universal headers.
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - Include `saveGlobalAsiakas: true` — without it the handler returns
 *     `success: true` but actually no-ops on the global asiakas row.
 *   - `asiakasContactPersonId` (NOT NULL) must be present; `0` is a valid
 *     "no contact person assigned" sentinel.
 */
export async function runCustomerUpdate(client, asiakasId, body, flags) {
    return client.post(`/api/asiakas/set/${asiakasId}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * DELETE /api/asiakas/delete/:asiakasId/:ownerAsiakasId. Universal write flags
 * surface as headers; `--reason` is enforced by the CLI layer.
 */
export async function runCustomerDelete(client, asiakasId, ownerAsiakasId, flags) {
    return client.delete(`/api/asiakas/delete/${asiakasId}/${ownerAsiakasId}`, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/asiakas/person/add — attach a person to a customer.
 * Forwards the universal write-flag headers.
 */
export async function runCustomerPersonAdd(client, body, flags) {
    return client.post("/api/asiakas/person/add", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/asiakas/person/remove — detach a person from a customer.
 * Forwards the universal write-flag headers.
 */
export async function runCustomerPersonRemove(client, body, flags) {
    return client.post("/api/asiakas/person/remove", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Register `ib customer` subcommands on the parent commander instance:
 *   - list    filterable by --limit/--cursor
 *   - get     single asiakas by id
 *   - search  free-text search (existing /api/asiakas/search route)
 *   - create  POST /api/asiakas/createY with --body JSON (write flags)
 *   - update  POST /api/asiakas/set/<asiakasId> with --body JSON (write flags)
 *
 * All mutation subcommands accept --dry-run / --idempotency-key / --reason.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerCustomerCommands(parent, getClient) {
    const c = parent.command("customer").description("Customer commands");
    c.command("list")
        .description("List customers")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .option("--cursor <c>", "Pagination cursor")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runCustomerList(client, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("get <asiakasId>")
        .description("Get a single customer by asiakasId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runCustomerGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("worksites <asiakasId>")
        .description("List worksites belonging to a customer")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            writeJson(await runCustomerWorksites(client, Number(idStr)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const modulesCmd = c
        .command("modules <asiakasId>")
        .description("Report or toggle a customer's module flags + roolit. Without --set/--unset: read-only report. Field keys: " +
        ALL_FIELD_KEYS.join(", "))
        .option("--set <keys>", "Comma-separated field keys to turn ON (e.g. jerry,weather,pumppu)")
        .option("--unset <keys>", "Comma-separated field keys to turn OFF");
    addWriteFlagsToCommand(modulesCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            if (!opts.set && !opts.unset) {
                writeJson(await runCustomerModulesReport(client, asiakasId));
                return;
            }
            let changes;
            try {
                changes = parseModuleChanges(opts.set, opts.unset);
            }
            catch (validationErr) {
                writeError(validationErr);
                process.exit(4);
            }
            const result = await runCustomerModulesApply(client, asiakasId, changes, {
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
    const operatorCmd = c
        .command("operator <asiakasId>")
        .description("Verify or provision the full operator preset (all 9 operator flags at once). System-admin, cross-tenant. Default (no flag): verify — exit 0 iff all 9 are on, else exit 1.")
        .option("--set", "Turn ALL 9 operator flags ON")
        .option("--reset", "Turn ALL 9 operator flags OFF");
    addWriteFlagsToCommand(operatorCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const asiakasId = Number(idStr);
            if (opts.set && opts.reset) {
                writeError(new Error("--set and --reset are mutually exclusive"));
                process.exit(4);
            }
            if (opts.set || opts.reset) {
                const changes = operatorPresetChanges(!!opts.set);
                const result = await runCustomerModulesApply(client, asiakasId, changes, {
                    dryRun: opts.dryRun,
                    idempotencyKey: opts.idempotencyKey,
                    reason: opts.reason,
                });
                writeJson(result);
                return;
            }
            // Verify (default): report state and gate the exit code on it.
            const result = await runCustomerOperatorVerify(client, asiakasId);
            writeJson(result);
            if (!result.allSet)
                process.exitCode = 1;
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("search <query>")
        .description("Free-text search for customers")
        .action(async (query) => {
        try {
            const client = await getClient();
            const result = await runCustomerSearch(client, query);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = c
        .command("create")
        .description("Create a new customer (POST /api/asiakas/createY)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runCustomerCreate(client, parsed, {
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
    const updateCmd = c
        .command("update <asiakasId>")
        .description("Update a customer (POST /api/asiakas/set/<asiakasId>)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runCustomerUpdate(client, Number(idStr), parsed, {
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
    addWriteFlagsToCommand(c
        .command("delete <asiakasId>")
        .description("Delete a customer (asiakas). Requires --reason.")).action(async (asiakasIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const ownerAsiakasId = await resolveOwnerAsiakasIdForWrite(client);
            const result = await runCustomerDelete(client, Number(asiakasIdStr), ownerAsiakasId, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const customerPerson = c
        .command("person")
        .description("Manage persons attached to a customer");
    addWriteFlagsToCommand(customerPerson
        .command("add")
        .description("Attach a person to a customer (asiakasPerson). Requires --reason.")
        .requiredOption("--asiakas <id>", "Target asiakasId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId (default 1 = pumppari)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runCustomerPersonAdd(client, { asiakasId: opts.asiakas, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(customerPerson
        .command("remove")
        .description("Detach a person from a customer (asiakasPerson). Requires --reason.")
        .requiredOption("--asiakas <id>", "Target asiakasId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId (default 1 = pumppari)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runCustomerPersonRemove(client, { asiakasId: opts.asiakas, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    customerPerson
        .command("list <asiakasId>")
        .description("List persons attached to a customer. Optional --role filter.")
        .option("--role <name>", "Filter by role name (e.g. keikkaHandler)")
        .action(async (asiakasIdStr, opts) => {
        try {
            const client = await getClient();
            const result = await runCustomerPersonList(client, Number(asiakasIdStr), opts.role);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
/**
 * Resolve the caller's current `ownerAsiakasId` via the existing
 * `/api/company-selection/available` route, used by every customer-write
 * subcommand that needs a tenant-owner segment in its URL.
 */
async function resolveOwnerAsiakasIdForWrite(client) {
    const available = await client.get("/api/company-selection/available");
    return available.currentCompanyId;
}
// `@ibetoni/constants` is a CommonJS package — pulled in via createRequire so
// the ESM build doesn't need a default-export shim.
const cjsRequire = createRequire(import.meta.url);
/**
 * GET /api/asiakas/person/list/:asiakasId/:roleTypeId — returns persons
 * attached to a customer, optionally filtered by role NAME (mapped to its
 * typeId via `ROLE_TYPEID_BY_NAME`).
 *
 * Backend response shape is `{ personList: [...] }` in production. Older
 * cache-warm paths and direct-query paths may return a bare array or the raw
 * mssql wrapper `{ recordset, recordsets, ... }`. Unwrapping defensively
 * accepts any of the three. The flat result is wrapped in the universal
 * `ListEnvelope` so output formatters can render it.
 */
export async function runCustomerPersonList(client, asiakasId, roleName) {
    const typeId = resolveRoleTypeId(roleName);
    // Backend `getAsiakasPersonList` sometimes returns the raw mssql result
    // wrapper `{ recordset, recordsets, ... }` instead of an unwrapped array
    // (depends on cache warmth + middleware path). Unwrap defensively so the
    // CLI is resilient to either shape.
    const raw = await client.get(`/api/asiakas/person/list/${asiakasId}/${typeId}`);
    let rows = [];
    if (Array.isArray(raw)) {
        rows = raw;
    }
    else if (raw && typeof raw === "object") {
        const wrapper = raw;
        rows = wrapper.personList || wrapper.recordset || wrapper.recordsets?.[0] || [];
    }
    const items = rows.map((r) => ({
        personId: r.personId,
        name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
        email: r.personEmail || null,
        role: r.asiakasPersonSettingTypeId || null,
    }));
    return { items, nextCursor: null, count: items.length };
}
//# sourceMappingURL=index.js.map