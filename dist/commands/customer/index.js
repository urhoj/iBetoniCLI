import { createRequire } from "node:module";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError } from "../../output/json.js";
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
            writeError(e);
            process.exit(1);
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
 * Translate a role NAME (e.g. "keikkaHandler") to its `asiakasPersonSettingTypeId`
 * using `ROLE_TYPEID_BY_NAME` from `@ibetoni/constants` (the single source of
 * truth). Returns `0` for an unset name (BE treats 0 as "no filter").
 *
 * Throws a descriptive error when the role is unknown so the CLI can surface
 * the list of valid names to the user.
 */
function resolveRoleTypeId(roleName) {
    if (!roleName)
        return 0;
    const constants = cjsRequire("@ibetoni/constants");
    const id = constants.ROLE_TYPEID_BY_NAME[roleName];
    if (!id) {
        const valid = Object.keys(constants.ROLE_TYPEID_BY_NAME).sort().join(", ");
        throw new Error(`unknown role: ${roleName}. Valid: ${valid}`);
    }
    return id;
}
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