import { unwrapRows } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith, errorMessage, } from "../../output/json.js";
import { decodeJwtPayload, impersonationFromClaims, } from "../../auth/jwt.js";
import { resolveCallerTier } from "../../tier.js";
import { resolveActiveOwnerAsiakasId } from "../../owner.js";
import { runCombinatorDuplicates, runCombinatorMerge, } from "../_shared/combinator.js";
import { roleNameForTypeId, resolveRoleTypeId, explainRole } from "../../roles.js";
import { parseId, parseOptionalId } from "../../targets.js";
import { runCompanyList } from "../company/index.js";
import { runNotificationFcmSend, parseJsonObject, } from "../notification/index.js";
import { CliError } from "../../api/errors.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { registerPersonDayCommands } from "./day.js";
import { registerPersonEmailCommands } from "./email.js";
import { registerPersonAbsencesCommand } from "./absences.js";
import { registerPersonActivityCommand } from "./activity.js";
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
    if (typed.memo !== undefined)
        body.personMemo = typed.memo;
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
    if (opts.owned)
        params.set("owned", "1");
    const qs = params.toString();
    return client.get(`/api/cli/person/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/person/get/:personId. Returns the flat backend record as-is.
 */
export async function runPersonGet(client, personId) {
    return client.get(`/api/cli/person/get/${personId}`);
}
/** Project one raw /api/person/search row to the clean PersonSearchHit shape. */
export function projectPersonHit(row) {
    const first = row.personFirstName ?? "";
    const last = row.personLastName ?? "";
    return {
        personId: Number(row.personId),
        name: `${first} ${last}`.trim(),
        email: row.personEmail ?? null,
        phone: row.personPhone ?? null,
        asiakasId: row.ownerAsiakasId != null ? Number(row.ownerAsiakasId) : null,
    };
}
/**
 * POST /api/person/search — existing (non-/api/cli/) route used by the FE
 * person typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI sends only searchString. Sent with
 * `{ read: true }` so this read-over-POST is exempt from the `--read-only`
 * write-lock and the acting-as diagnostic. The raw backend rows (a bare array
 * or an mssql `{ recordset }` wrapper) are normalised via `unwrapRows` and
 * projected by `projectPersonHit` into the documented
 * `ListEnvelope<PersonSearchHit>`.
 */
export async function runPersonSearch(client, query, limit) {
    const body = { searchString: query };
    if (limit !== undefined)
        body.limit = limit;
    const raw = await client.post("/api/person/search", body, { read: true });
    const items = unwrapRows(raw).map(projectPersonHit);
    return { items, nextCursor: null, count: items.length };
}
/**
 * Search persons across the caller's companies (`--my-companies`) via the
 * server-side endpoint `GET /api/cli/person/search` — ONE round-trip, no
 * per-company switching. If that endpoint isn't deployed yet (404/405), falls
 * back to the legacy client-side fan-out so the command works pre- and
 * post-deploy. `opts.fallback` supplies the fan-out; `opts.limit` is forwarded.
 */
export async function runPersonSearchMyCompanies(client, query, opts) {
    const qs = new URLSearchParams({ q: query });
    if (opts.limit !== undefined)
        qs.set("limit", String(opts.limit));
    try {
        return await client.get(`/api/cli/person/search?${qs.toString()}`);
    }
    catch (e) {
        // Endpoint not deployed yet → fall back to the client-side fan-out.
        if (e instanceof CliError && (e.statusCode === 404 || e.statusCode === 405)) {
            return opts.fallback();
        }
        throw e;
    }
}
/**
 * Legacy client-side fan-out for `--my-companies` (the fallback when the
 * server endpoint isn't deployed). `listCompanies` yields the companies to
 * sweep; `searchIn(asiakasId)` runs the search in one company (the caller binds
 * the query + an ephemeral per-company client). Each hit is tagged with its
 * authoritative company and merged into one ListEnvelope.
 */
export async function runPersonSearchMyCompaniesFanout(listCompanies, searchIn) {
    const companies = await listCompanies();
    const items = [];
    for (const c of companies) {
        const env = await searchIn(c.asiakasId);
        for (const hit of env.items) {
            items.push({ ...hit, asiakasId: c.asiakasId, asiakasName: c.name });
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
    const result = await client.post(`/api/asiakasPersonSettings/add/${asiakasId}/${personId}/${roleTypeId}`, {}, { headers: writeFlagsToHeaders(flags) });
    // A real write returns bare/raw backend success (useless to an agent); project
    // it to `{ granted: { personId, asiakasId, roleTypeId } }` (the ids are the
    // inputs). A dry-run preview (`{ dryRun, wouldCreate }`) is passed through.
    if (result && typeof result === "object" && result.dryRun) {
        return result;
    }
    return { granted: { personId, asiakasId, roleTypeId } };
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
    const token = client.getCurrentToken();
    const claims = decodeJwtPayload(token);
    const impersonating = impersonationFromClaims(claims);
    const personId = claims.personId ?? failWith("could not resolve personId from the active token", 4);
    const [profile, available] = await Promise.all([
        client.get(`/api/cli/person/get/${personId}`),
        client.get(`/api/company-selection/available`),
    ]);
    const companies = available.companies || [];
    const active = companies.find((c) => c.asiakasId === available.currentCompanyId);
    return {
        personId,
        name: profile.name ?? null,
        email: profile.email ?? claims.email ?? null,
        phone: profile.phone ?? null,
        activeCompany: {
            asiakasId: available.currentCompanyId,
            name: active?.asiakasNimi ?? active?.name ?? null,
        },
        tier: resolveCallerTier(token),
        roles: (profile.roles || []).map((t) => ({ roleTypeId: t, role: roleNameForTypeId(t) })),
        companies: companies.map((c) => ({
            asiakasId: c.asiakasId,
            name: c.asiakasNimi ?? c.name ?? "",
            current: c.asiakasId === available.currentCompanyId,
        })),
        ...(impersonating ? { impersonating } : {}),
    };
}
/**
 * `ib person companies [personId]` — the customers a person belongs to (reverse
 * of `customer person list`). personId defaults to the caller (from the JWT).
 * GET /api/person/getUserAsiakasList/:personId; defensive unwrap of mssql shapes.
 */
export async function runPersonCompanies(client, personId) {
    const id = personId ??
        decodeJwtPayload(client.getCurrentToken()).personId ??
        failWith("could not resolve personId from the active token", 4);
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
/** person-combinator request-body id fields (see puminet5api personCombinatorRoutes). */
const PERSON_MERGE_ID_FIELDS = {
    mainField: "mainPersonId",
    secondaryField: "secondaryPersonId",
};
/**
 * GET /api/admin/person-combinator/duplicates — likely-duplicate person pairs
 * for one tenant (same phone / email / first+last name). Admin gated server-side.
 * Feeds `ib person merge`. See runCombinatorDuplicates for the envelope shape.
 */
export function runPersonDuplicates(client, ownerAsiakasId) {
    return runCombinatorDuplicates(client, "person-combinator", ownerAsiakasId);
}
/**
 * Merge two duplicate persons — the secondary's references move onto the main,
 * then the secondary is deleted. IRREVERSIBLE, admin gated. `--dry-run` runs the
 * read-only /validate safety check (works under --read-only). See runCombinatorMerge.
 */
export function runPersonMerge(client, opts, flags) {
    return runCombinatorMerge(client, "person-combinator", PERSON_MERGE_ID_FIELDS, opts, flags);
}
/**
 * Register `ib person` read subcommands on the parent commander instance:
 *   - list    filterable by --role/--asiakas/--limit
 *   - get     single person by personId
 *   - search  free-text search (existing POST /api/person/search route)
 *   - duplicates  likely-duplicate person pairs for a tenant (read; admin; feeds merge)
 *   - merge   merge two duplicate persons (--dry-run = /validate; IRREVERSIBLE; requires --reason)
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerPersonCommands(parent, getClient, getClientForAsiakas) {
    const p = parent.command("person").description("Person commands");
    registerPersonDayCommands(p, getClient);
    registerPersonEmailCommands(p, getClient);
    registerPersonAbsencesCommand(p, getClient);
    registerPersonActivityCommand(p, getClient);
    p.command("list")
        .description("List persons")
        .option("--role <role>", "Filter by role name")
        .option("--asiakas <id>", "Filter by asiakasId", (v) => Number(v))
        .option("--owned", "List persons the company OWNS instead of its members (the default)")
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
            const result = await runPersonGet(client, parseId(idStr, "personId"));
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
                const result = await runPersonSearchMyCompanies(client, query, {
                    limit: opts.limit,
                    // Fallback used only if the server endpoint isn't deployed yet.
                    fallback: () => runPersonSearchMyCompaniesFanout(async () => (await runCompanyList(client)).items.map((c) => ({
                        asiakasId: c.asiakasId,
                        name: c.name,
                    })), async (asiakasId) => runPersonSearch(await getClientForAsiakas(asiakasId), query, opts.limit)),
                });
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
    const notifyCmd = p
        .command("notify <person>")
        .description("Send an FCM push to a person (alias for `ib notification fcm send --person`). " +
        "Admin/HR only. <person> is a personId or a name resolved within your company. " +
        "--dry-run previews recipient + device count.")
        .requiredOption("--title <text>", "Notification title")
        .requiredOption("--body <text>", "Notification body")
        .option("--data <json>", "Extra FCM data payload as a JSON object", parseJsonObject);
    addWriteFlagsToCommand(notifyCmd).action(async (person, opts) => {
        try {
            const result = await runNotificationFcmSend(await getClient(), { person, title: opts.title, body: opts.body, data: opts.data }, {
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
    const createCmd = p
        .command("create")
        .description("Create a person. Required: --first, --last. --email is OPTIONAL (phone-only " +
        "contacts are fine; add the email later). --asiakas defaults to your active " +
        "company. Returns the created person record (clean {personId, ...}). With " +
        "--get-or-create a duplicate email returns the existing person (reused:true) " +
        "ONLY when that person is visible to you; an email owned by a company you can't " +
        "access errors with guidance (the dedup is global). Use typed flags or --body " +
        "JSON (typed flags win). Requires --reason.")
        .option("--first <s>", "personFirstName (required)")
        .option("--last <s>", "personLastName (required)")
        .option("--phone <s>", "personPhone")
        .option("--email <s>", "personEmail (optional)")
        .option("--memo <s>", "personMemo — free-text note/comment (optional)")
        .option("--asiakas <id>", "Owner asiakasId (defaults to your active company)", Number)
        .option("--global", "Create a GLOBAL, self-managing person with no owner (ownerAsiakasId=null), discoverable across companies. Mutually exclusive with --asiakas.")
        .option("--get-or-create", "On a duplicate email, return the existing person (reused:true) when visible to you; an email owned by a company you can't access errors with guidance")
        .option("--body <json>", "Raw JSON body (merged under typed flags)")
        .option("--from-json <file>", "Read the JSON body from a file (or - for stdin) — shell-safe alternative to --body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        // --global and --asiakas are mutually exclusive owner directives.
        if (opts.global && opts.asiakas !== undefined) {
            failWith("--global and --asiakas are mutually exclusive", 4);
        }
        let parsed = {};
        try {
            parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson }) ?? {};
        }
        catch (e) {
            exitWithError(e);
            return;
        }
        const body = buildPersonCreateBody(parsed, {
            first: opts.first,
            last: opts.last,
            phone: opts.phone,
            email: opts.email,
            memo: opts.memo,
            asiakas: opts.asiakas,
            global: opts.global,
        });
        const missing = missingPersonCreateFields(body);
        if (missing.length > 0) {
            failWith(`create requires: ${missing.join(", ")}`, 4);
        }
        try {
            const client = await getClient();
            // ownerAsiakasId is needed by person_add; default it to the active company
            // when neither --asiakas nor --body supplied one — but NOT for --global,
            // whose null owner is intentional.
            if (!opts.global && (body.ownerAsiakasId === undefined || body.ownerAsiakasId === null)) {
                body.ownerAsiakasId = await resolveActiveOwnerAsiakasId(client, "run `ib auth switch` or pass --asiakas / ownerAsiakasId in --body");
            }
            let res;
            try {
                res = await runPersonCreate(client, body, opts);
            }
            catch (e) {
                // --get-or-create: a duplicate email isn't a failure — return the
                // person that already owns it (so bulk onboarding is idempotent).
                if (opts.getOrCreate && body.personEmail && isDuplicateEmailError(e)) {
                    let existing = null;
                    try {
                        existing = await runPersonByEmail(client, String(body.personEmail));
                    }
                    catch (lookupErr) {
                        // The recovery lookup itself can 404 (the email's owner is in a
                        // company you can't see, or the route isn't deployed). Don't surface
                        // that as a misleading "person not found" — fall through to the clear
                        // guidance below.
                        if (!(lookupErr instanceof CliError && lookupErr.statusCode === 404))
                            throw lookupErr;
                    }
                    if (existing) {
                        writeJson({ ...existing, reused: true });
                        return;
                    }
                    // The email collides globally (the dedup is not tenant-scoped) but its
                    // owner is not visible to you — --get-or-create can only hand back a
                    // person you can access. Give an actionable error, not a bare 400/404.
                    failWith(`email ${body.personEmail} is already in use by a person you cannot access ` +
                        `(likely owned by another company). --get-or-create only returns persons ` +
                        `visible to you — locate them with \`ib person search --my-companies\` or use a different email.`, 4);
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
            let created;
            try {
                created = await runPersonGet(client, newId);
            }
            catch (e) {
                // GET /api/cli/person/get is scoped to your ACTIVE company, so a person
                // created under a non-active owned company (--asiakas <other>) 404s on
                // read-back even though the create COMMITTED. Synthesize the record from
                // the inputs instead of surfacing a misleading "person not found" that
                // implies the write failed.
                if (e instanceof CliError && e.statusCode === 404) {
                    created = {
                        personId: newId,
                        name: `${body.personFirstName || ""} ${body.personLastName || ""}`.trim() || null,
                        email: body.personEmail ?? null,
                        phone: body.personPhone ?? null,
                        ownerAsiakasId: body.ownerAsiakasId ?? null,
                        note: "created under a non-active company; record synthesized from inputs (the read-back is scoped to your active company)",
                    };
                }
                else {
                    throw e;
                }
            }
            writeJson(opts.getOrCreate ? { ...created, reused: false } : created);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(p
        .command("update <personId>")
        .description("Update a person. Body REQUIRED via --body or --from-json. Requires --reason.")
        .option("--body <json>", "Patch body (JSON)")
        .option("--from-json <file>", "Read the patch body from a file (or - for stdin) — shell-safe alternative to --body")).action(async (personIdStr, opts) => {
        if (!opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const patch = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson });
            if (!patch) {
                failWith("update requires a patch body via --body or --from-json", 4);
            }
            const client = await getClient();
            const result = await runPersonUpdate(client, parseId(personIdStr, "personId"), patch, opts);
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
            failWith("Missing required flag: --reason", 4);
        }
        const hasGlobal = !!opts.global;
        const hasAsiakas = opts.asiakas !== undefined;
        if (hasGlobal === hasAsiakas) {
            failWith("provide exactly one of --global or --asiakas <id>", 4);
        }
        const ownerAsiakasId = hasGlobal ? null : opts.asiakas;
        try {
            const client = await getClient();
            const result = await runPersonSetOwner(client, parseId(personIdStr, "personId"), ownerAsiakasId, opts);
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
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const client = await getClient();
            const result = await runPersonDelete(client, parseId(personIdStr, "personId"), opts);
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
            const result = await runPersonRoleList(client, parseId(personIdStr, "personId"), opts.asiakas);
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
            failWith("Missing required flag: --reason", 4);
        }
        let roleTypeId;
        try {
            roleTypeId = resolveRoleTypeId(opts.role);
        }
        catch (validationErr) {
            failWith(errorMessage(validationErr), 4);
        }
        // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
        // must name a real role, so reject the empty-string case rather than POST a
        // bogus roleTypeId 0 to the backend.
        if (!roleTypeId) {
            failWith("--role must not be empty", 4);
        }
        try {
            const client = await getClient();
            const result = await runPersonRoleGrant(client, parseId(personIdStr, "personId"), opts.asiakas, roleTypeId, opts);
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
            failWith("Missing required flag: --reason", 4);
        }
        let roleTypeId;
        try {
            roleTypeId = resolveRoleTypeId(opts.role);
        }
        catch (validationErr) {
            failWith(errorMessage(validationErr), 4);
        }
        // resolveRoleTypeId returns 0 for an empty/unset name; --role is required and
        // must name a real role, so reject the empty-string case rather than POST a
        // bogus roleTypeId 0 to the backend.
        if (!roleTypeId) {
            failWith("--role must not be empty", 4);
        }
        try {
            const client = await getClient();
            const result = await runPersonRoleRevoke(client, parseId(personIdStr, "personId"), opts.asiakas, roleTypeId, opts);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // `explain` resolves typeId/tiers/deprecation OFFLINE from @ibetoni/constants,
    // then enriches with the LIVE DB description/comment via an authenticated GET
    // (GET /api/asiakasPersonSettings/getAllTypes) — the network/transform logic
    // lives in `explainRole` (src/roles.ts), keeping this action thin. It disambiguates
    // the role names accepted by `person role grant/revoke` (and `customer person list --role`).
    personRole
        .command("explain <name>")
        .description("Explain a role name: typeId, display name, DB description/comment, access tiers, deprecation")
        .action(async (name) => {
        try {
            const client = await getClient();
            writeJson(await explainRole(client, name));
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
            const result = await runPersonCompanies(client, parseOptionalId(personIdStr, "personId"));
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    p.command("duplicates")
        .description("List likely-duplicate person pairs for a tenant (same phone / email / " +
        "first+last name). Read-only; admin gated. Owner defaults to your active " +
        "company; --owner scans another tenant. Feeds `ib person merge`.")
        .option("--owner <id>", "ownerAsiakasId to scan (default: active company)", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
            writeJson(await runPersonDuplicates(client, owner));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const personMergeCmd = p
        .command("merge")
        .description("Merge two duplicate persons: the secondary's references move onto the main, " +
        "then the secondary is DELETED. IRREVERSIBLE, admin gated. --dry-run runs the " +
        "read-only /validate safety check (never merges). A real merge requires --reason.")
        .requiredOption("--main <id>", "personId to KEEP (references merge into this)", Number)
        .requiredOption("--secondary <id>", "personId to REMOVE (merged away, then deleted)", Number)
        .option("--owner <id>", "ownerAsiakasId (default: active company)", Number);
    addWriteFlagsToCommand(personMergeCmd).action(async (opts) => {
        if (!Number.isInteger(opts.main) || opts.main <= 0 ||
            !Number.isInteger(opts.secondary) || opts.secondary <= 0) {
            failWith("--main and --secondary must be positive integer personIds", 4);
        }
        if (opts.main === opts.secondary) {
            failWith("--main and --secondary must differ", 4);
        }
        if (!opts.dryRun && !opts.reason) {
            failWith("person merge is irreversible — pass --reason (or --dry-run to preview via /validate)", 4);
        }
        try {
            const client = await getClient();
            const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client, "pass --owner <id>"));
            writeJson(await runPersonMerge(client, { mainId: opts.main, secondaryId: opts.secondary, ownerAsiakasId: owner }, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    p.command("log <personId>")
        .description("Change-tracker audit trail for one person (who changed what, when, with --reason). " +
        "Includes role grants/revokes — pass `--field asiakasPersonSetting` for role changes only.")
        .option("--owner <id>", "ownerAsiakasId (default: active company)", (v) => Number(v))
        .option("--limit <n>", "Max rows (default 100, cap 500)", (v) => Math.min(Number(v), 500), 100)
        .option("--field <name>", "Filter by changeTracker fieldName (e.g. asiakasPersonSetting)")
        .action(async (personIdStr, opts) => {
        try {
            const client = await getClient();
            const result = await runPersonHistory(client, parseId(personIdStr, "personId"), opts.limit, {
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
 * GET /api/changes/person/:personId/:ownerAsiakasId — the change-tracker audit
 * trail for one person (the same log every `--reason` write feeds). Includes
 * role grants/revokes (fieldName "asiakasPersonSetting"); pass `field` to filter
 * client-side to one fieldName. Owner defaults to the active company. The route
 * returns a RAW array (sendSuccess(changes), no .data wrapper). Auth: company
 * member or admin (BE-enforced). Mirrors runCustomerHistory.
 */
export async function runPersonHistory(client, personId, limit, opts = {}) {
    const owner = opts.owner ?? (await resolveActiveOwnerAsiakasId(client));
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