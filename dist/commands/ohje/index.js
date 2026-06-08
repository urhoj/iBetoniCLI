import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, writeError, exitWithError } from "../../output/json.js";
/** Charset the backend sanitizer (helps.get / helps.update) accepts for a helpId. */
const HELP_ID_RE = /^[A-Za-z0-9_-]+$/;
/**
 * GET /api/helps/get/:helpId — the content shown in a HelperIcon modal. The
 * backend returns a recordset (array); we surface the first row, or `null` when
 * the helpId has no entry yet (the route returns an empty array, not a 404).
 */
export async function runOhjeGet(client, helpId) {
    const rows = await client.get(`/api/helps/get/${encodeURIComponent(helpId)}`);
    return Array.isArray(rows) ? rows[0] ?? null : rows;
}
/**
 * GET /api/helps/getAll — every UI help entry, projected into the universal
 * list envelope so `--pretty` renders it as a table.
 */
export async function runOhjeList(client) {
    const rows = await client.get("/api/helps/getAll");
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length };
}
/**
 * Project commander options into {@link OhjeFields}: typed flags win over
 * `--body` JSON (mirrors `buildSijaintiBody`). `--img ""` is coerced to `null`
 * so an image can be CLEARED — otherwise `helps_save` would store an empty
 * string instead of NULL. Exported (pure) so the merge is unit-testable without
 * spawning the CLI.
 */
export function buildOhjeFields(opts) {
    const parsed = opts.body ? JSON.parse(opts.body) : {};
    const img = opts.img ?? parsed.img;
    return {
        title: opts.title ?? parsed.title,
        shorttext: opts.shorttext ?? parsed.shorttext,
        htmltext: opts.htmltext ?? parsed.htmltext,
        img: img === "" ? null : img,
    };
}
/**
 * Merge the changed fields over the current row to form the full PUT body.
 * `helps_save` overwrites EVERY column, so a partial edit must carry the
 * existing values through or it would blank them — exactly what the HelperIcon
 * editor does (it posts full state). Only the five persisted columns are
 * emitted (helps_save reads just these), so extra GET columns
 * (rev/accessCount/timestamps) are NOT echoed back — keeping the `--dry-run`
 * `proposed` clean. An omitted field (`undefined`) falls back to the current
 * value, then to "" ; an explicit `null` img clears the column.
 */
export function buildOhjeBody(current, helpId, fields) {
    const base = current ?? {};
    return {
        helpId,
        title: fields.title ?? base.title ?? "",
        shorttext: fields.shorttext ?? base.shorttext ?? "",
        htmltext: fields.htmltext ?? base.htmltext ?? "",
        img: fields.img !== undefined ? fields.img : base.img ?? null,
    };
}
/**
 * Update one help entry (PUT /api/helps/update). The backend does NOT honour
 * X-Dry-Run on this route, so `--dry-run` is resolved CLIENT-SIDE: we GET the
 * current row, compute the merged proposed row, and return it WITHOUT writing —
 * a truthful preview instead of a silent persist. A real write GET-merges-PUTs
 * the full row (see buildOhjeBody) so untouched columns survive. Server-side
 * requires isHelperEditor (or system-admin/developer).
 */
export async function runOhjeUpdate(client, helpId, fields, flags) {
    const current = await runOhjeGet(client, helpId);
    const proposed = buildOhjeBody(current, helpId, fields);
    if (flags.dryRun) {
        return { dryRun: true, helpId, current, proposed };
    }
    return client.put("/api/helps/update", proposed, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Register `ib ohje` subcommands on the parent commander instance:
 *   - get <helpId>     single help entry (GET /api/helps/get/:helpId)
 *   - list             every help entry, as a list envelope (GET /api/helps/getAll)
 *   - update <helpId>  GET-merge-PUT one entry; --reason required; --dry-run
 *                      previews the merged row client-side without writing
 *
 * Exit codes: 4 = missing --reason / bad input; otherwise the contract-mapped
 * codes via exitWithError (2 auth · 3 permission · 4 validation · 5 not-found).
 */
export function registerOhjeCommands(parent, getClient) {
    const o = parent
        .command("ohje")
        .description("UI help-text content (the helps table behind HelperIcon) — end-user help, NOT `ib --help`");
    o.command("get <helpId>")
        .description("Get one UI help entry by helpId (GET /api/helps/get/:helpId)")
        .action(async (helpId) => {
        if (!HELP_ID_RE.test(helpId)) {
            writeError(new Error(`Invalid helpId "${helpId}" — only [A-Za-z0-9_-] are allowed`));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const result = await runOhjeGet(client, helpId);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    o.command("list")
        .description("List every UI help entry (GET /api/helps/getAll)")
        .action(async () => {
        try {
            const client = await getClient();
            const result = await runOhjeList(client);
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = o
        .command("update <helpId>")
        .description("Update a UI help entry (PUT /api/helps/update). GET-merges the current row " +
        "so omitted fields are preserved (helps_save overwrites the whole row). " +
        "Provide typed flags or --body JSON (typed flags win). --reason is required. " +
        "--dry-run previews the merged row CLIENT-SIDE without writing (the backend " +
        "does not honour X-Dry-Run here). Requires isHelperEditor or system-admin/developer.")
        .option("--body <json>", "JSON object with any of title/shorttext/htmltext/img (typed flags win)")
        .option("--title <s>", "Help title (otsikko)")
        .option("--shorttext <s>", "Short text (shorttext)")
        .option("--htmltext <s>", "HTML body shown in the modal (htmltext)")
        .option("--img <s>", "Image reference (img)");
    addWriteFlagsToCommand(updateCmd).action(async (helpId, opts) => {
        if (!HELP_ID_RE.test(helpId)) {
            writeError(new Error(`Invalid helpId "${helpId}" — only [A-Za-z0-9_-] are allowed`));
            process.exit(4);
        }
        // --reason is required for an actual write; a --dry-run preview is
        // read-only, so it does not need a justification.
        if (!opts.dryRun && !opts.reason) {
            writeError(new Error("Missing required flag: --reason"));
            process.exit(4);
        }
        try {
            const client = await getClient();
            const fields = buildOhjeFields(opts);
            const result = await runOhjeUpdate(client, helpId, fields, {
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