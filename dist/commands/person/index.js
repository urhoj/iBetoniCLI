import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { roleNameForTypeId, resolveRoleTypeId } from "../../roles.js";
/**
 * GET /api/cli/person/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runPersonList(client, opts) {
    const params = new URLSearchParams();
    if (opts.role)
        params.set("role", opts.role);
    if (opts.asiakas !== undefined)
        params.set("asiakas", String(opts.asiakas));
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    return client.get(`/api/cli/person/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/person/get/:personId. Returns the flat backend record as-is.
 */
export async function runPersonGet(client, personId) {
    return client.get(`/api/cli/person/get/${personId}`);
}
/**
 * POST /api/person/search — existing (non-/api/cli/) route used by the FE
 * person typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI sends only searchString. Result
 * shape is whatever the backend returns (typically an array of person records).
 */
export async function runPersonSearch(client, query) {
    return client.post("/api/person/search", { searchString: query });
}
/**
 * GET /api/asiakasPersonSettings/get/:asiakasId/:personId — the per-company
 * roles a person holds. Resolves each asiakasPersonSettingTypeId to its role
 * name (null for non-role/unknown typeIds). The backend may return a bare
 * array or an mssql wrapper ({ recordset } / { recordsets }) depending on cache
 * warmth — unwrap defensively. Wrapped in the universal ListEnvelope.
 */
export async function runPersonRoleList(client, personId, asiakasId) {
    const raw = await client.get(`/api/asiakasPersonSettings/get/${asiakasId}/${personId}`);
    let rows = [];
    if (Array.isArray(raw)) {
        rows = raw;
    }
    else if (raw && typeof raw === "object") {
        rows = raw.recordset || raw.recordsets?.[0] || [];
    }
    const items = rows.map((r) => ({
        asiakasPersonSettingId: r.asiakasPersonSettingId,
        roleTypeId: r.asiakasPersonSettingTypeId,
        role: roleNameForTypeId(r.asiakasPersonSettingTypeId),
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * POST /api/asiakasPersonSettings/add/:asiakasId/:personId/:roleTypeId — grant
 * a per-company role. roleTypeId fills the route's positional :personSettingTypeId
 * segment. Body is empty ({}). Write-flag headers (incl. X-Dry-Run) are forwarded;
 * under dry-run the wrapped backend returns { dryRun:true, wouldCreate }.
 */
export async function runPersonRoleGrant(client, personId, asiakasId, roleTypeId, flags) {
    return client.post(`/api/asiakasPersonSettings/add/${asiakasId}/${personId}/${roleTypeId}`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Revoke a per-company role. Two-step: list the person's roles for the company,
 * find the row whose roleTypeId matches, then DELETE it by asiakasPersonSettingId.
 * Idempotent — returns { removed: 0 } (no DELETE) when the role is absent. Under
 * --dry-run the DELETE forwards X-Dry-Run and the wrapped backend returns
 * { dryRun:true, wouldDelete }, passed through; otherwise returns { removed: 1 }.
 */
export async function runPersonRoleRevoke(client, personId, asiakasId, roleTypeId, flags) {
    const current = await runPersonRoleList(client, personId, asiakasId);
    const match = current.items.find((i) => i.roleTypeId === roleTypeId);
    if (!match)
        return { removed: 0 };
    const res = await client.delete(`/api/asiakasPersonSettings/delete/${match.asiakasPersonSettingId}`, { headers: writeFlagsToHeaders(flags) });
    return flags.dryRun ? res : { removed: 1 };
}
/**
 * `ib person me` — the caller's own rich profile. Derives personId from the JWT
 * (works for IB_TOKEN sessions with no credentials file), then composes
 * /api/cli/person/get/:personId (profile + roles) and
 * /api/company-selection/available (actable companies). `roles` are aggregated
 * across ALL the person's companies (the backend role subquery is not asiakas-
 * scoped); use `person role list --asiakas <id>` for one company's roles.
 */
export async function runPersonMe(client) {
    const claims = decodeJwtPayload(client.getCurrentToken());
    const profile = await client.get(`/api/cli/person/get/${claims.personId}`);
    const available = await client.get(`/api/company-selection/available`);
    const companies = available.companies || [];
    const active = companies.find((c) => c.asiakasId === available.currentCompanyId);
    return {
        personId: claims.personId,
        name: profile.name ?? null,
        email: profile.email ?? claims.email ?? null,
        phone: profile.phone ?? null,
        activeCompany: {
            asiakasId: available.currentCompanyId,
            name: active?.asiakasNimi ?? active?.name ?? null,
        },
        roles: (profile.roles || []).map((t) => ({ roleTypeId: t, role: roleNameForTypeId(t) })),
        companies: companies.map((c) => ({
            asiakasId: c.asiakasId,
            name: c.asiakasNimi ?? c.name ?? "",
            current: c.asiakasId === available.currentCompanyId,
        })),
    };
}
/**
 * `ib person companies [personId]` — the customers a person belongs to (reverse
 * of `customer person list`). personId defaults to the caller (from the JWT).
 * GET /api/person/getUserAsiakasList/:personId; defensive unwrap of mssql shapes.
 */
export async function runPersonCompanies(client, personId) {
    const id = personId ?? decodeJwtPayload(client.getCurrentToken()).personId;
    const raw = await client.get(`/api/person/getUserAsiakasList/${id}`);
    let rows = [];
    if (Array.isArray(raw)) {
        rows = raw;
    }
    else if (raw && typeof raw === "object") {
        rows = raw.recordset || raw.recordsets?.[0] || [];
    }
    const items = rows.map((r) => ({ asiakasId: r.asiakasId, name: r.asiakasNimi ?? r.asiakasName ?? r.name ?? null }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * Register `ib person` read subcommands on the parent commander instance:
 *   - list    filterable by --role/--asiakas/--limit
 *   - get     single person by personId
 *   - search  free-text search (existing POST /api/person/search route)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerPersonCommands(parent, getClient) {
    const p = parent.command("person").description("Person commands");
    p.command("list")
        .description("List persons")
        .option("--role <role>", "Filter by role name")
        .option("--asiakas <id>", "Filter by asiakasId", (v) => Number(v))
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runPersonList(client, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    p.command("get <personId>")
        .description("Get a single person by personId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runPersonGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    p.command("search <query>")
        .description("Free-text search for persons")
        .action(async (query) => {
        try {
            const client = await getClient();
            const result = await runPersonSearch(client, query);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(p
        .command("create")
        .description("Create a person. Body REQUIRED via --body. Requires --reason.")
        .requiredOption("--body <json>", "Person body (JSON). Must include personFirstName, personLastName, personEmail.")).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        let body;
        try {
            body = JSON.parse(opts.body);
        }
        catch {
            writeError(new Error("--body must be valid JSON"));
            process.exit(4);
        }
        for (const required of ["personFirstName", "personLastName", "personEmail"]) {
            if (!(required in body)) {
                writeError(new Error(`Body missing required field: ${required}`));
                process.exit(4);
            }
        }
        try {
            const client = await getClient();
            const result = await runPersonCreate(client, body, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(p
        .command("update <personId>")
        .description("Update a person. Body REQUIRED via --body. Requires --reason.")
        .requiredOption("--body <json>", "Patch body (JSON)")).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        let patch;
        try {
            patch = JSON.parse(opts.body);
        }
        catch {
            writeError(new Error("--body must be valid JSON"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runPersonUpdate(client, Number(personIdStr), patch, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(p
        .command("delete <personId>")
        .description("Delete a person. Requires --reason.")).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runPersonDelete(client, Number(personIdStr), opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // ─── person role subgroup ────────────────────────────────────────────────
    const personRole = p
        .command("role")
        .description("Manage a person's per-company roles (asiakasPersonSettings)");
    personRole
        .command("list <personId>")
        .description("List a person's roles in a company")
        .requiredOption("--asiakas <id>", "Target asiakasId", (v) => Number(v))
        .action(async (personIdStr, opts) => {
        try {
            const client = await getClient();
            const result = await runPersonRoleList(client, Number(personIdStr), opts.asiakas);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(personRole
        .command("grant <personId>")
        .description("Grant a role to a person in a company. Requires --role, --asiakas, --reason.")
        .requiredOption("--role <name>", "Role name (see ROLE_TYPEID_BY_NAME)")
        .requiredOption("--asiakas <id>", "Target asiakasId", (v) => Number(v))).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        let roleTypeId;
        try {
            roleTypeId = resolveRoleTypeId(opts.role);
        }
        catch (validationErr) {
            writeError(validationErr);
            process.exit(4);
        }
        // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
        // must name a real role, so reject the empty-string case rather than POST a
        // bogus roleTypeId 0 to the backend.
        if (!roleTypeId) {
            writeError(new Error("--role must not be empty"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runPersonRoleGrant(client, Number(personIdStr), opts.asiakas, roleTypeId, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(personRole
        .command("revoke <personId>")
        .description("Revoke a role from a person in a company (idempotent). Requires --role, --asiakas, --reason.")
        .requiredOption("--role <name>", "Role name (see ROLE_TYPEID_BY_NAME)")
        .requiredOption("--asiakas <id>", "Target asiakasId", (v) => Number(v))).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        let roleTypeId;
        try {
            roleTypeId = resolveRoleTypeId(opts.role);
        }
        catch (validationErr) {
            writeError(validationErr);
            process.exit(4);
        }
        // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
        // must name a real role, so reject the empty-string case rather than POST a
        // bogus roleTypeId 0 to the backend.
        if (!roleTypeId) {
            writeError(new Error("--role must not be empty"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runPersonRoleRevoke(client, Number(personIdStr), opts.asiakas, roleTypeId, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // ─── self-introspection ───────────────────────────────────────────────────
    p.command("me")
        .description("Your own profile, your roles across all your companies, and actable companies")
        .action(async () => {
        try {
            const client = await getClient();
            const result = await runPersonMe(client);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    p.command("companies [personId]")
        .description("List the companies a person belongs to (defaults to you)")
        .action(async (personIdStr) => {
        try {
            const client = await getClient();
            const result = await runPersonCompanies(client, personIdStr ? Number(personIdStr) : undefined);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
/**
 * POST /api/person/newPerson — create a new person record.
 * Body must include personFirstName, personLastName, personEmail.
 *
 * Response shape note: the backend wraps the result as
 * `{ status: "ok", data: { recordsets, output, rowsAffected, returnValue } }`.
 * The new personId is at `data.returnValue` — callers that need it should
 * unwrap accordingly. See `puminet5api/utils/test/test-cli-lifecycle.js` for a
 * tolerant fallback chain that handles older shapes too.
 */
export async function runPersonCreate(client, body, flags) {
    return client.post("/api/person/newPerson", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/person/set — partial update for an existing person.
 * `personId` is merged into the body alongside the caller's patch.
 */
export async function runPersonUpdate(client, personId, patch, flags) {
    return client.post("/api/person/set", { personId, ...patch }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * DELETE /api/person/delete/:personId — remove a person record.
 */
export async function runPersonDelete(client, personId, flags) {
    return client.delete(`/api/person/delete/${personId}`, { headers: writeFlagsToHeaders(flags) });
}
//# sourceMappingURL=index.js.map