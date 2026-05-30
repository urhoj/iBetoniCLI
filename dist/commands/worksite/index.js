import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError } from "../../output/json.js";
/**
 * GET /api/cli/worksite/list with the universal list envelope shape.
 * Query parameters are appended only when set on `opts`.
 */
export async function runWorksiteList(client, opts) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.cursor)
        params.set("cursor", opts.cursor);
    const qs = params.toString();
    return client.get(`/api/cli/worksite/list${qs ? `?${qs}` : ""}`);
}
/**
 * GET /api/cli/worksite/get/:tyomaaId. Returns the flat backend record as-is.
 */
export async function runWorksiteGet(client, tyomaaId) {
    return client.get(`/api/cli/worksite/get/${tyomaaId}`);
}
/**
 * POST /api/tyomaa/search — existing (non-/api/cli/) route used by the FE
 * worksite typeahead. Body is `{ searchString: <query> }`. The backend scopes
 * results to the caller's company (req.user.ownerAsiakasId) when no
 * ownerAsiakasId is in the body, so the CLI sends only searchString. Result
 * shape is whatever the backend returns (typically an array of tyomaa records).
 */
export async function runWorksiteSearch(client, query) {
    return client.post("/api/tyomaa/search", { searchString: query });
}
/**
 * POST /api/tyomaa/new with a free-form body forwarded to the existing BE
 * endpoint (FE: `tyomaa_save_to_db()`). Write flags surface as the universal
 * `X-Dry-Run` / `Idempotency-Key` / `X-Action-Reason` headers.
 *
 * Body shape pitfalls verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - `ownerAsiakasId` is required (validateRequiredFields).
 *   - `tyomaaContactPersonId` has a NOT NULL constraint; pass `0` for
 *     "no contact assigned".
 */
export async function runWorksiteCreate(client, body, flags) {
    return client.post("/api/tyomaa/new", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Format today's date as YYYYMMDD (no separators), in local time. Used as the
 * default `yyyymmdd` URL segment for /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd
 * when the caller doesn't supply one.
 */
function todayYyyymmdd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
}
/**
 * POST /api/tyomaa/set/:ownerAsiakasId/:tyomaaId/:yyyymmdd with a free-form
 * body. `ownerAsiakasId` comes from the caller's credentials context and must
 * be passed in by the action wiring. `yyyymmdd` defaults to today in local
 * time (YYYYMMDD, no separators).
 *
 * Body shape pitfall verified by the lifecycle smoke
 * (`puminet5api/utils/test/test-cli-lifecycle.js`):
 *   - The handler runs `validateRequiredFields(body, ["tyomaaId", "ownerAsiakasId"])`,
 *     so both ids must be in the BODY too even though they're already in the URL.
 */
export async function runWorksiteUpdate(client, opts, body, flags) {
    const yyyymmdd = opts.yyyymmdd || todayYyyymmdd();
    return client.post(`/api/tyomaa/set/${opts.ownerAsiakasId}/${opts.tyomaaId}/${yyyymmdd}`, body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * DELETE /api/tyomaa/delete/:tyomaaId. Universal write flags surface as
 * headers; `--reason` is enforced by the CLI layer.
 */
export async function runWorksiteDelete(client, tyomaaId, flags) {
    return client.delete(`/api/tyomaa/delete/${tyomaaId}`, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/tyomaa/person/add — attach a person to a worksite.
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonAdd(client, body, flags) {
    return client.post("/api/tyomaa/person/add", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * POST /api/tyomaa/person/remove — detach a person from a worksite.
 * Forwards the universal write-flag headers.
 */
export async function runWorksitePersonRemove(client, body, flags) {
    return client.post("/api/tyomaa/person/remove", body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * GET /api/tyomaa/person/list/:tyomaaId/0 — returns persons attached to a
 * worksite. The second URL segment is a typeId placeholder (the FE / BE
 * route shape mirrors `asiakas/person/list`); we always pass `0` because
 * tyomaaPerson links don't have a per-role filter. The flat backend array is
 * wrapped in the universal `ListEnvelope` so output formatters can render it.
 */
export async function runWorksitePersonList(client, tyomaaId) {
    const rows = await client.get(`/api/tyomaa/person/list/${tyomaaId}/0`);
    const items = (rows || []).map((r) => ({
        personId: r.personId,
        name: `${r.personFirstName || ""} ${r.personLastName || ""}`.trim(),
        email: r.personEmail || null,
        contactType: r.contactPersonTypeId || null,
    }));
    return { items, nextCursor: null, count: items.length };
}
/**
 * Register `ib worksite` subcommands on the parent commander instance:
 *   - list    filterable by --limit/--cursor
 *   - get     single tyomaa by id
 *   - search  free-text search (existing POST /api/tyomaa/search route)
 *   - create  POST /api/tyomaa/new with --body JSON (write flags)
 *   - update  POST /api/tyomaa/set/<ownerAsiakasId>/<tyomaaId>/<yyyymmdd>
 *
 * The `update` action currently takes `--owner-asiakas-id <id>` as a temporary
 * flag until G.3 wires the auto-derive from the credentials context.
 * `--yyyymmdd` defaults to today.
 *
 * Exit codes: 1 = generic API/runtime failure.
 */
export function registerWorksiteCommands(parent, getClient) {
    const w = parent.command("worksite").description("Worksite commands");
    w.command("list")
        .description("List worksites")
        .option("--limit <n>", "Max rows", (v) => Math.min(Number(v), 500))
        .option("--cursor <c>", "Pagination cursor")
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runWorksiteList(client, opts);
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    w.command("get <tyomaaId>")
        .description("Get a single worksite by tyomaaId")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            const result = await runWorksiteGet(client, Number(idStr));
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    w.command("search <query>")
        .description("Free-text search for worksites")
        .action(async (query) => {
        try {
            const client = await getClient();
            const result = await runWorksiteSearch(client, query);
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    const createCmd = w
        .command("create")
        .description("Create a new worksite (POST /api/tyomaa/new)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runWorksiteCreate(client, parsed, {
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
    const updateCmd = w
        .command("update <tyomaaId>")
        .description("Update a worksite (POST /api/tyomaa/set/<ownerAsiakasId>/<tyomaaId>/<yyyymmdd>)")
        .requiredOption("--body <json>", "JSON object forwarded verbatim as the request body")
        .requiredOption("--owner-asiakas-id <id>", "Owner asiakasId (temporary; auto-derived in G.3)", (v) => Number(v))
        .option("--yyyymmdd <date>", "Date segment YYYYMMDD (defaults to today)");
    addWriteFlagsToCommand(updateCmd).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const parsed = JSON.parse(opts.body);
            const result = await runWorksiteUpdate(client, {
                tyomaaId: Number(idStr),
                ownerAsiakasId: opts.ownerAsiakasId,
                yyyymmdd: opts.yyyymmdd,
            }, parsed, {
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
    addWriteFlagsToCommand(w
        .command("delete <tyomaaId>")
        .description("Delete a worksite (tyomaa). Requires --reason.")).action(async (tyomaaIdStr, opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runWorksiteDelete(client, Number(tyomaaIdStr), opts);
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    const worksitePerson = w
        .command("person")
        .description("Manage persons attached to a worksite");
    addWriteFlagsToCommand(worksitePerson
        .command("add")
        .description("Attach a person to a worksite (tyomaaPerson). Requires --reason.")
        .requiredOption("--worksite <id>", "Target tyomaaId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runWorksitePersonAdd(client, { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    addWriteFlagsToCommand(worksitePerson
        .command("remove")
        .description("Detach a person from a worksite. Requires --reason.")
        .requiredOption("--worksite <id>", "Target tyomaaId", Number)
        .requiredOption("--person <id>", "Target personId", Number)
        .option("--contact-type <id>", "contactPersonTypeId (default 1)", Number, 1)).action(async (opts) => {
        if (!opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runWorksitePersonRemove(client, { tyomaaId: opts.worksite, personId: opts.person, contactPersonTypeId: opts.contactType }, opts);
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    worksitePerson
        .command("list <tyomaaId>")
        .description("List persons attached to a worksite.")
        .action(async (tyomaaIdStr) => {
        try {
            const client = await getClient();
            const result = await runWorksitePersonList(client, Number(tyomaaIdStr));
            writeJson(result);
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
}
//# sourceMappingURL=index.js.map