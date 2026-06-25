import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { assertAiConfidence, addAssessWriteFlags, addNeedsReviewFlags } from "../../assess.js";
import { lineDiff } from "../../textDiff.js";
import { applyTextEdit, parseEditOp } from "../../textEdit.js";
/**
 * helpId validity: any non-empty string up to the `dbo.helps.helpId` column
 * width (nvarchar 250). The backend binds it as a parameter (no string-built
 * SQL), so no charset restriction is needed — real helpIds contain `:`, spaces,
 * commas, and Finnish letters (e.g. `tila:2`, `"XC3, XC4, XF1"`, `käyttöikä`).
 */
const HELP_ID_MAX = 250;
export function isValidHelpId(s) {
    return typeof s === "string" && s.length > 0 && s.length <= HELP_ID_MAX;
}
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
 * list envelope so `--pretty` renders it as a table. The route accepts no query
 * params, so `--empty-shorttext` / `--fields` / `--sort` / `--limit` are applied
 * CLIENT-SIDE here. This is important for AI callers: the full table is ~115 KB
 * (191 rows × full htmltext), so `--empty-shorttext --fields helpId,title,accessCount`
 * is the cheap one-step fetch for grooming instead of dumping everything.
 * Order: filter → sort → limit → project.
 */
export async function runOhjeList(client, opts = {}) {
    const rows = await client.get("/api/helps/getAll");
    let all = Array.isArray(rows) ? rows : [];
    if (opts.emptyShorttext) {
        all = all.filter((r) => !String(r.shorttext ?? "").trim());
    }
    if (opts.needsReview) {
        const max = opts.maxConfidence ?? 90;
        all = all.filter((r) => {
            const c = r.aiConfidence;
            const below = c == null || (typeof c === "number" && c < max);
            const parked = r.needsHumanReview === true || r.needsHumanReview === 1;
            return below && !parked;
        });
        if (!opts.sort)
            opts = { ...opts, sort: "lastModifiedTime:asc" };
    }
    if (opts.sort) {
        const [field, dirRaw] = opts.sort.split(":");
        const desc = (dirRaw ?? "asc").toLowerCase() === "desc";
        all = [...all].sort((a, b) => {
            const av = a[field];
            const bv = b[field];
            const c = typeof av === "number" && typeof bv === "number"
                ? av - bv
                : String(av ?? "").localeCompare(String(bv ?? ""));
            return desc ? -c : c;
        });
    }
    let items = opts.limit && opts.limit > 0 ? all.slice(0, opts.limit) : all;
    if (opts.fields && opts.fields.length) {
        items = items.map((r) => {
            const projected = {};
            for (const f of opts.fields)
                projected[f] = r[f];
            return projected;
        });
    }
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
    const parsed = opts.body ? parseJsonBodyFlag(opts.body) : {};
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
export async function runOhjeUpdate(client, helpId, fields, flags, opts = {}, assess = {}) {
    const current = await runOhjeGet(client, helpId);
    // The GET already tells us whether a row exists — surface it so callers can
    // detect an UNEXPECTED insert (a typo'd Finnish helpId silently creates a junk
    // row otherwise). `--must-exist` turns that into a hard failure instead.
    const created = current === null;
    if (opts.mustExist && created) {
        failWith(`helpId "${helpId}" has no existing row and --must-exist was set (refusing to create a new entry)`, 4);
    }
    const proposed = buildOhjeBody(current, helpId, fields);
    // aiConfidence/needsHumanReview come ONLY from the flags — never from `current`.
    // buildOhjeBody emits just the 5 content columns, so an omitted --ai-confidence
    // leaves the key out of the body and the backend resets the stored score to NULL.
    const payload = { ...proposed };
    if (assess.aiConfidence !== undefined)
        payload.aiConfidence = assess.aiConfidence;
    if (assess.needsHumanReview)
        payload.needsHumanReview = true;
    if (flags.dryRun) {
        return { dryRun: true, helpId, created, current, proposed: payload };
    }
    const response = await client.put("/api/helps/update", payload, {
        headers: writeFlagsToHeaders(flags),
    });
    // Echo what was written (the merged row) + a length so a parallel grooming
    // agent can spot a truncation/encoding issue without a separate `ohje get`.
    return {
        success: true,
        helpId,
        created,
        written: payload,
        htmltextLength: (proposed.htmltext ?? "").length,
        response,
    };
}
/** Text fields editable in-field (img is not text; helpId is the key). */
export const OHJE_EDITABLE_FIELDS = ["title", "shorttext", "htmltext"];
/**
 * Edit mode for `ohje update`: in-field partial edit of ONE text column. Fetches
 * the current row (exit 5 if the helpId has no row — you cannot edit a body that
 * does not exist), applies the edit, then `--dry-run` returns the field diff
 * without writing, or a real run delegates to `runOhjeUpdate` (which GET-merges
 * so the other columns survive).
 */
export async function runOhjeEditField(client, helpId, field, op, flags, assess = {}) {
    const current = await runOhjeGet(client, helpId);
    if (current === null) {
        failWith(`helpId "${helpId}" has no existing row to edit — create it with a full --${field} first`, 5);
    }
    const before = String(current[field] ?? "");
    const { next, matchCount } = applyTextEdit(before, op);
    if (flags.dryRun) {
        const diff = lineDiff(before, next);
        return {
            dryRun: true,
            helpId,
            field,
            ...(matchCount !== undefined ? { matchCount } : {}),
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            sameContent: diff.sameContent,
            unified: diff.unified,
        };
    }
    return runOhjeUpdate(client, helpId, { [field]: next }, flags, {}, assess);
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
        if (!isValidHelpId(helpId)) {
            failWith(`Invalid helpId "${helpId}" — must be 1–250 characters`, 4);
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
    addNeedsReviewFlags(o.command("list")
        .description("List every UI help entry (GET /api/helps/getAll). Reads are public. The full " +
        "table is large (~115 KB), so use the client-side shapers to keep output small: " +
        "--empty-shorttext (grooming backfill targets), --fields (column projection, skips " +
        "htmltext), --sort field:dir. Order applied: filter → sort → limit → project.")
        .option("--limit <n>", "Max rows to return (client-side cap, after filter+sort)", (v) => Number(v))
        .option("--empty-shorttext", "Only rows whose shorttext is blank (grooming backfill targets)")
        .option("--fields <cols>", "Comma-separated columns to keep, e.g. helpId,title,shorttext,accessCount (drops the large htmltext)", (v) => v.split(",").map((s) => s.trim()).filter(Boolean))
        .option("--sort <field:dir>", "Sort by a column, e.g. accessCount:desc (numeric fields compare numerically)"))
        .action(async (opts) => {
        try {
            const client = await getClient();
            const result = await runOhjeList(client, opts);
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
        .option("--img <s>", "Image reference (img)")
        .option("--must-exist", "Fail (exit 4) if no row exists for this helpId instead of upserting a new one " +
        "(guards against a typo'd helpId silently creating a junk row)")
        .option("--field <name>", "Edit-mode target field: title | shorttext | htmltext (default htmltext)")
        .option("--replace <text>", "Edit mode: replace this literal text in the target field (exactly once unless --all)")
        .option("--with <text>", 'Replacement for --replace ("" deletes the matched text)')
        .option("--append <text>", "Edit mode: append text to the target field (verbatim)")
        .option("--prepend <text>", "Edit mode: prepend text to the target field (verbatim)")
        .option("--all", "With --replace: substitute every occurrence");
    addWriteFlagsToCommand(addAssessWriteFlags(updateCmd)).action(async (helpId, opts) => {
        if (!isValidHelpId(helpId)) {
            failWith(`Invalid helpId "${helpId}" — must be 1–250 characters`, 4);
        }
        const editOp = parseEditOp({
            replace: opts.replace, with: opts.with,
            append: opts.append, prepend: opts.prepend, all: opts.all,
        });
        if (opts.field !== undefined && !editOp) {
            failWith("--field only applies in edit mode (--replace / --append / --prepend)", 4);
        }
        if (editOp) {
            if (opts.body || opts.title || opts.shorttext || opts.htmltext || opts.img !== undefined) {
                failWith("edit mode (--replace/--append/--prepend) cannot be combined with --body/--title/--shorttext/--htmltext/--img", 4);
            }
            const rawField = opts.field ?? "htmltext";
            if (!OHJE_EDITABLE_FIELDS.includes(rawField)) {
                failWith(`--field must be one of: ${OHJE_EDITABLE_FIELDS.join(", ")}`, 4);
            }
            const field = rawField;
            if (!opts.dryRun && !opts.reason)
                failWith("Missing required flag: --reason", 4);
            assertAiConfidence(opts.aiConfidence);
            try {
                const client = await getClient();
                writeJson(await runOhjeEditField(client, helpId, field, editOp, { dryRun: opts.dryRun, idempotencyKey: opts.idempotencyKey, reason: opts.reason }, { aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview }));
            }
            catch (e) {
                exitWithError(e);
            }
            return;
        }
        assertAiConfidence(opts.aiConfidence);
        // --reason is required for an actual write; a --dry-run preview is
        // read-only, so it does not need a justification.
        if (!opts.dryRun && !opts.reason) {
            failWith("Missing required flag: --reason", 4);
        }
        try {
            const client = await getClient();
            const fields = buildOhjeFields(opts);
            const result = await runOhjeUpdate(client, helpId, fields, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }, { mustExist: opts.mustExist }, { aiConfidence: opts.aiConfidence, needsHumanReview: opts.needsHumanReview });
            writeJson(result);
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map