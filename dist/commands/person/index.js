import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { roleNameForTypeId, resolveRoleTypeId } from "../../roles.js";
import { runCompanyList } from "../company/index.js";
import { CliError } from "../../api/errors.js";
/**
 * Merge typed create flags over a parsed --body object (typed flags win) into the
 * /api/person/newPerson body. Email is intentionally optional: person.personEmail
 * is nullable and the backend only dedupes when an email is actually given, so a
 * phone-first contact can be created now and have its email added later. Body keys
 * not covered by a typed flag are preserved untouched.
 */
export function buildPersonCreateBody(parsedBody, typed) {
    const body = { ...parsedBody };
    if (typed.first !== undefined)
        body.personFirstName = typed.first;
    if (typed.last !== undefined)
        body.personLastName = typed.last;
    if (typed.phone !== undefined)
        body.personPhone = typed.phone;
    if (typed.email !== undefined)
        body.personEmail = typed.email;
    if (typed.asiakas !== undefined)
        body.ownerAsiakasId = typed.asiakas;
    if (typed.global)
        body.ownerAsiakasId = null;
    return body;
}
/**
 * Required-field check for person create: first + last name (email is optional).
 * Treats null/empty as missing. Returns the missing flag labels (empty = ok).
 */
export function missingPersonCreateFields(body) {
    const missing = [];
    const present = (v) => v !== undefined && v !== null && v !== "";
    if (!present(body.personFirstName))
        missing.push("--first (personFirstName)");
    if (!present(body.personLastName))
        missing.push("--last (personLastName)");
    return missing;
}
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
export async function runPersonSearch(client, query, limit) {
    const body = { searchString: query };
    if (limit !== undefined)
        body.limit = limit;
    return client.post("/api/person/search", body);
}
/**
 * /api/person/search returns either a bare array of person rows or a raw mssql
 * result wrapper ({ recordset } / { recordsets: [[...]] }) depending on cache
 * warmth. Normalise both to a flat array of row objects.
 */
export function extractPersonRows(raw) {
    if (Array.isArray(raw))
        return raw;
    if (raw && typeof raw === "object") {
        const obj = raw;
        if (Array.isArray(obj.recordset)) {
            return obj.recordset;
        }
        if (Array.isArray(obj.recordsets) && Array.isArray(obj.recordsets[0])) {
            return obj.recordsets[0];
        }
    }
    return [];
}
/**
 * Fan a person search out across the caller's companies (`--my-companies`).
 * `listCompanies` yields the companies to sweep; `searchIn(asiakasId)` runs the
 * search in one company (the caller binds the query + an ephemeral per-company
 * client). Each hit is projected to a clean, company-tagged row and merged into
 * one ListEnvelope so cross-company results are disambiguable.
 */
export async function runPersonSearchMyCompanies(listCompanies, searchIn) {
    const companies = await listCompanies();
    const items = [];
    for (const c of companies) {
        const raw = await searchIn(c.asiakasId);
        for (const row of extractPersonRows(raw)) {
            const first = row.personFirstName ?? "";
            const last = row.personLastName ?? "";
            items.push({
                personId: Number(row.personId),
                name: `${first} ${last}`.trim(),
                email: row.personEmail ?? null,
                phone: row.personPhone ?? null,
                asiakasId: c.asiakasId,
                asiakasName: c.name,
            });
        }
    }
    return { items, nextCursor: null, count: items.length };
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
    const [profile, available] = await Promise.all([
        client.get(`/api/cli/person/get/${claims.personId}`),
        client.get(`/api/company-selection/available`),
    ]);
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
export function registerPersonCommands(parent, getClient, getClientForAsiakas) {
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
        .option("--limit <n>", "Max results", (v) => Math.min(Number(v), 500))
        .option("--my-companies", "Search across every company you belong to (each hit tagged with its asiakasId)")
        .action(async (query, opts) => {
        try {
            const client = await getClient();
            if (opts.myCompanies) {
                const result = await runPersonSearchMyCompanies(async () => (await runCompanyList(client)).items.map((c) => ({
                    asiakasId: c.asiakasId,
                    name: c.name,
                })), async (asiakasId) => runPersonSearch(await getClientForAsiakas(asiakasId), query, opts.limit));
                writeJson(result);
                return;
            }
            const result = await runPersonSearch(client, query, opts.limit);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = p
        .command("create")
        .description("Create a person. Required: --first, --last. --email is OPTIONAL (phone-only " +
        "contacts are fine; add the email later). --asiakas defaults to your active " +
        "company. Returns the created person record (clean {personId, ...}). With " +
        "--get-or-create a duplicate email returns the existing person (reused:true) " +
        "instead of failing. Use typed flags or --body JSON (typed flags win). Requires --reason.")
        .option("--first <s>", "personFirstName (required)")
        .option("--last <s>", "personLastName (required)")
        .option("--phone <s>", "personPhone")
        .option("--email <s>", "personEmail (optional)")
        .option("--asiakas <id>", "Owner asiakasId (defaults to your active company)", Number)
        .option("--global", "Create a GLOBAL, self-managing person with no owner (ownerAsiakasId=null), discoverable across companies. Mutually exclusive with --asiakas.")
        .option("--get-or-create", "On a duplicate email, return the existing person (reused:true) instead of failing")
        .option("--body <json>", "Raw JSON body (merged under typed flags)");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        // --global and --asiakas are mutually exclusive owner directives.
        if (opts.global && opts.asiakas !== undefined) {
            writeError(new Error("--global and --asiakas are mutually exclusive"));
            process.exit(4);
        }
        let parsed = {};
        if (opts.body) {
            try {
                parsed = JSON.parse(opts.body);
            }
            catch {
                writeError(new Error("--body must be valid JSON"));
                process.exit(4);
            }
        }
        const body = buildPersonCreateBody(parsed, {
            first: opts.first,
            last: opts.last,
            phone: opts.phone,
            email: opts.email,
            asiakas: opts.asiakas,
            global: opts.global,
        });
        const missing = missingPersonCreateFields(body);
        if (missing.length > 0) {
            writeError(new Error(`create requires: ${missing.join(", ")}`));
            process.exit(4);
        }
        try {
            const client = await getClient();
            // ownerAsiakasId is needed by person_add; default it to the active company
            // when neither --asiakas nor --body supplied one — but NOT for --global,
            // whose null owner is intentional.
            if (!opts.global && (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null)) {
                body.ownerAsiakasId = await resolveOwnerAsiakasId(client);
            }
            let res;
            try {
                res = await runPersonCreate(client, body, opts);
            }
            catch (e) {
                // --get-or-create: a duplicate email isn't a failure — return the
                // person that already owns it (so bulk onboarding is idempotent).
                if (opts.getOrCreate && body.personEmail && isDuplicateEmailError(e)) {
                    const existing = await runPersonByEmail(client, String(body.personEmail));
                    if (existing) {
                        writeJson({ ...existing, reused: true });
                        return;
                    }
                }
                throw e;
            }
            // Dry-run returns the backend's wouldCreate echo verbatim.
            if (opts.dryRun) {
                writeJson(res);
                return;
            }
            // Return a clean person record (re-fetched) instead of the raw SQL
            // recordset (returnValue:N) the create proc emits.
            const newId = extractPersonId(res);
            if (!newId) {
                writeJson(res);
                return;
            }
            const created = await runPersonGet(client, newId);
            writeJson(opts.getOrCreate ? { ...created, reused: false } : created);
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
        .command("owner <personId>")
        .description("Set or clear a person's owner company (ownerAsiakasId). Provide EXACTLY ONE of " +
        "--global (make the person global/self-managing, ownerAsiakasId=null) or " +
        "--asiakas <id> (assign/move ownership). Roles are separate (see `person role`). " +
        "Requires --reason. Authz: developer=any; self → global always, self → a company you " +
        "belong to; company-admin may release a person owned by their company → global.")
        .option("--global", "Make the person GLOBAL (ownerAsiakasId=null)")
        .option("--asiakas <id>", "Set owner to this asiakasId", Number)).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        const hasGlobal = !!opts.global;
        const hasAsiakas = opts.asiakas !== undefined;
        if (hasGlobal === hasAsiakas) {
            writeError(new Error("provide exactly one of --global or --asiakas <id>"));
            process.exit(4);
        }
        const ownerAsiakasId = hasGlobal ? null : opts.asiakas;
        try {
            const client = await getClient();
            const result = await runPersonSetOwner(client, Number(personIdStr), ownerAsiakasId, opts);
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
    p.command("history <personId>")
        .description("Change-tracker audit trail for one person (who changed what, when, with --reason). " +
        "Includes role grants/revokes — pass `--field asiakasPersonSetting` for role changes only.")
        .option("--owner <id>", "ownerAsiakasId (default: active company)", (v) => Number(v))
        .option("--limit <n>", "Max rows (default 100, cap 500)", (v) => Math.min(Number(v), 500), 100)
        .option("--field <name>", "Filter by changeTracker fieldName (e.g. asiakasPersonSetting)")
        .action(async (personIdStr, opts) => {
        try {
            const client = await getClient();
            const result = await runPersonHistory(client, Number(personIdStr), opts.limit, {
                owner: opts.owner,
                field: opts.field,
            });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
/**
 * Resolve the caller's active ownerAsiakasId via the existing
 * /api/company-selection/available route (same pattern as customer/sijainti
 * create). Throws a clear error if no active company resolves.
 */
async function resolveOwnerAsiakasId(client) {
    const available = await client.get("/api/company-selection/available");
    if (typeof available.currentCompanyId !== "number" || available.currentCompanyId <= 0) {
        throw new Error("could not resolve active company — run `ib auth switch` or pass --asiakas / ownerAsiakasId in --body");
    }
    return available.currentCompanyId;
}
/**
 * GET /api/changes/person/:personId/:ownerAsiakasId — the change-tracker audit
 * trail for one person (the same log every `--reason` write feeds). Includes
 * role grants/revokes (fieldName "asiakasPersonSetting"); pass `field` to filter
 * client-side to one fieldName. Owner defaults to the active company. The route
 * returns a RAW array (sendSuccess(changes), no .data wrapper). Auth: company
 * member or admin (BE-enforced). Mirrors runCustomerHistory.
 */
export async function runPersonHistory(client, personId, limit, opts = {}) {
    const owner = opts.owner ?? (await resolveOwnerAsiakasId(client));
    const rows = await client.get(`/api/changes/person/${personId}/${owner}?limit=${limit}`);
    let list = Array.isArray(rows) ? rows : [];
    if (opts.field)
        list = list.filter((r) => r.fieldName === opts.field);
    return {
        items: list.map((r) => ({
            changeId: r.changeId,
            field: r.fieldName ?? null,
            oldValue: r.oldValue ?? null,
            newValue: r.newValue ?? null,
            changeType: r.changeType ?? null,
            personId: r.personId ?? null,
            personName: r.personFullName ?? null,
            at: r.timestamp ?? null,
            description: r.description ?? null,
            reason: r.reason ?? null,
        })),
        nextCursor: null,
        count: list.length,
    };
}
/** Pull the new personId out of newPerson's response (tolerant of legacy shapes). */
export function extractPersonId(res) {
    const r = res;
    if (!r || typeof r !== "object")
        return null;
    const data = r.data;
    const candidates = [
        r.returnValue,
        data?.returnValue,
        r.personId,
        r.recordset?.[0]?.personId,
        data?.recordset?.[0]?.personId,
    ];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isInteger(n) && n > 0)
            return n;
    }
    return null;
}
/** True when an error is the backend's "email already in use" 400 from newPerson. */
export function isDuplicateEmailError(e) {
    if (!(e instanceof CliError) || e.statusCode !== 400)
        return false;
    const hay = `${e.message} ${JSON.stringify(e.body ?? "")}`.toLowerCase();
    return hay.includes("käytössä") || hay.includes("already in use") || hay.includes("duplicate");
}
/**
 * GET /api/person/getPersonByEmail/:email — look up a person by exact email
 * (proc person_getByEmail; email is globally unique, so NOT tenant-scoped).
 * Used by `person create --get-or-create` to recover the person that already
 * owns an email. Returns a tidy {personId,name,email} or null.
 */
export async function runPersonByEmail(client, email) {
    const rows = await client.get(`/api/person/getPersonByEmail/${encodeURIComponent(email)}`);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || !row.personId)
        return null;
    return {
        personId: row.personId,
        name: `${row.personFirstName || ""} ${row.personLastName || ""}`.trim() || null,
        email: row.personEmail || null,
    };
}
/**
 * POST /api/person/newPerson — create a new person record.
 * Body needs personFirstName + personLastName (+ ownerAsiakasId); personEmail
 * is optional (the column is nullable and the backend only dedupes when given).
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
 * POST /api/person/setOwner/:personId — set or clear a person's ownerAsiakasId.
 * `ownerAsiakasId: null` makes the person GLOBAL (self-managing, cross-tenant
 * discoverable); a positive id assigns/moves ownership. Server-side authz applies
 * (developer = any; self → null always / → a company you belong to; company-admin
 * may release a person owned by their company → global). Write-flag headers
 * (incl. X-Dry-Run, X-Action-Reason) are forwarded.
 */
export async function runPersonSetOwner(client, personId, ownerAsiakasId, flags) {
    return client.post(`/api/person/setOwner/${personId}`, { ownerAsiakasId }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * DELETE /api/person/delete/:personId — remove a person record.
 */
export async function runPersonDelete(client, personId, flags) {
    return client.delete(`/api/person/delete/${personId}`, { headers: writeFlagsToHeaders(flags) });
}
//# sourceMappingURL=index.js.map