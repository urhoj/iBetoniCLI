import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../../output/json.js";
import { resolveDate, todayHelsinki } from "../../../dates.js";
/** Priority levels the board UI renders (info=primary, warning=warning, urgent=error). */
const PRIORITIES = ["info", "warning", "urgent"];
/**
 * The active-list endpoint wants a COMPACT `YYYYMMDD` integer-string (regex
 * `^\d{8}$`), NOT the ISO `YYYY-MM-DD` the rest of the CLI uses for date flags.
 * This helper bridges that divergence: relative aliases (`today` / `yesterday`
 * / `tomorrow`) and ISO dates are normalised via the shared `resolveDate`, then
 * the dashes are stripped; a bare 8-digit string passes through. Exported (pure)
 * so the conversion is unit-testable. Returns `null` for anything that is not a
 * valid `YYYYMMDD` after normalisation, so the action can fail with exit 4
 * instead of letting the backend reject an opaque value.
 */
export function toBoardQueryDate(input) {
    const iso = resolveDate(input ?? "today") ?? todayHelsinki();
    const compact = iso.replace(/-/g, "");
    return /^\d{8}$/.test(compact) ? compact : null;
}
/** Wrap a backend array into the universal `{ items, nextCursor, count }` envelope. */
function toEnvelope(rows) {
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length };
}
/**
 * GET /api/ilmoitustaulu?date=YYYYMMDD — notices ACTIVE on a given day
 * (`startDate <= date AND (expiresAt IS NULL OR expiresAt >= date)`), newest
 * first. Open to any authenticated company member. The web app filters
 * per-device "dismissed" ids on top of this — the CLI has no dismiss state, so
 * it returns the full active set.
 */
export async function runBoardList(client, dateYyyymmdd) {
    return toEnvelope(await client.get(`/api/ilmoitustaulu?date=${encodeURIComponent(dateYyyymmdd)}`));
}
/**
 * GET /api/ilmoitustaulu/all — EVERY notice for the company including expired
 * and not-yet-started ones (the admin-panel view). Requires admin/editor.
 */
export async function runBoardAll(client) {
    return toEnvelope(await client.get("/api/ilmoitustaulu/all"));
}
/**
 * Get one notice by id. The backend exposes NO single-message GET route, so we
 * fetch `/all` and filter client-side (same admin/editor gate as `all`).
 * Returns `null` when the id is not in the company's set — the caller maps that
 * to exit 5.
 */
export async function runBoardGet(client, messageId) {
    const all = await runBoardAll(client);
    return all.items.find((m) => Number(m.messageId) === messageId) ?? null;
}
/**
 * Project commander options into {@link BoardFields}: relative date aliases are
 * expanded to ISO via `resolveDate`; an explicit empty `--expires-at ""` is
 * coerced to `null` so the expiry can be CLEARED (otherwise the backend would
 * store an empty string). Exported (pure) so the merge is unit-testable without
 * spawning the CLI.
 */
export function buildBoardFields(opts) {
    const expiresRaw = opts.expiresAt;
    return {
        title: opts.title,
        body: opts.text,
        priority: opts.priority,
        startDate: resolveDate(opts.startDate),
        expiresAt: expiresRaw === undefined
            ? undefined
            : expiresRaw === ""
                ? null
                : resolveDate(expiresRaw) ?? null,
    };
}
/**
 * Merge changed fields over the current row to form the full write body. The
 * backend's create/update validator REQUIRES `title`, `body` and `startDate`
 * and overwrites every column, so a partial edit must carry the existing values
 * through or it would blank them (exactly the GET-merge-PUT shape `ib ohje`
 * uses). `priority` falls back to the current value then to `info`; `expiresAt`
 * keeps the current value unless explicitly provided (`null` clears it). Only
 * the five writable columns are emitted, so server-only columns
 * (messageId/createdAt/createdBy/…) never echo back into a `--dry-run` preview.
 */
export function buildBoardBody(current, fields) {
    const base = current ?? {};
    return {
        title: fields.title ?? base.title,
        body: fields.body ?? base.body,
        priority: fields.priority ?? base.priority ?? "info",
        startDate: fields.startDate ?? base.startDate,
        expiresAt: fields.expiresAt !== undefined ? fields.expiresAt : base.expiresAt ?? null,
    };
}
/**
 * Create a notice (POST /api/ilmoitustaulu). `--dry-run` is resolved
 * CLIENT-SIDE: the route has NO X-Dry-Run guard ([[feedback_ib_dryrun_deploy_gated]]),
 * so a "dry-run" that POSTed would actually persist. Instead we return the
 * proposed payload and write NOTHING. A real create POSTs the body; the
 * read-only write-lock naturally blocks the non-GET when active.
 */
export async function runBoardCreate(client, fields, flags) {
    const proposed = buildBoardBody(null, fields);
    if (flags.dryRun)
        return { dryRun: true, proposed };
    return client.post("/api/ilmoitustaulu", proposed, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Update a notice (PUT /api/ilmoitustaulu/:messageId). GET-merges the current
 * row (via `/all`) so omitted fields are preserved — the backend overwrites the
 * whole row. `--dry-run` is CLIENT-SIDE (no server X-Dry-Run guard): we return
 * the current + merged proposed row WITHOUT writing. A missing id exits 5.
 * Server-side enforces admin (any row) / editor (own rows only).
 */
export async function runBoardUpdate(client, messageId, fields, flags) {
    const current = await runBoardGet(client, messageId);
    if (!current)
        failWith(`No board message with id ${messageId}`, 5);
    const proposed = buildBoardBody(current, fields);
    if (flags.dryRun)
        return { dryRun: true, messageId, current, proposed };
    return client.put(`/api/ilmoitustaulu/${messageId}`, proposed, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Delete a notice (DELETE /api/ilmoitustaulu/:messageId, returns 204).
 * `--dry-run` is CLIENT-SIDE: we fetch the row (via `/all`) and return what
 * WOULD be deleted without issuing the DELETE — a truthful preview the server's
 * (absent) dry-run guard cannot give. A missing id exits 5. Server-side
 * enforces admin (any row) / editor (own rows only).
 */
export async function runBoardDelete(client, messageId, flags) {
    const current = await runBoardGet(client, messageId);
    if (!current)
        failWith(`No board message with id ${messageId}`, 5);
    if (flags.dryRun)
        return { dryRun: true, messageId, wouldDelete: current };
    return client.delete(`/api/ilmoitustaulu/${messageId}`, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Validate a positive-integer messageId positional, or exit 4. */
function parseMessageId(raw) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
        failWith(`Invalid messageId "${raw}" — expected a positive integer`, 4);
    }
    return id;
}
/** Validate priority against the {info,warning,urgent} enum, or exit 4. */
function assertPriority(priority) {
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
        failWith(`Invalid --priority "${priority}" — use ${PRIORITIES.join("|")}`, 4);
    }
}
/**
 * Register the `board` sub-group on the `ib message` umbrella parent.
 * `ilmoitustaulu` is an alias so both `ib message board` and the
 * (Finnish, spec-canonical) `ib message ilmoitustaulu` resolve here.
 *
 *   list   [--date today|YYYYMMDD]   active notices for a day (any member)
 *   all                              every notice incl. expired (admin/editor)
 *   get    <messageId>               one notice (client-side filter over /all)
 *   create --title --text --start-date [--priority] [--expires-at]   --reason
 *   update <messageId> [fields]      GET-merge-PUT; --dry-run previews client-side
 *   delete <messageId>               --reason; --dry-run previews client-side
 *
 * Signature matches `registerMessageChatCommands(parent, getClient)` so the
 * umbrella can mount both sub-groups the same way.
 */
export function registerMessageBoardCommands(parent, getClient) {
    const b = parent
        .command("board")
        .alias("ilmoitustaulu")
        .description("Company announcement board (ilmoitustaulu) — dated one-to-many notices shown to every member");
    b.command("list")
        .description("List notices ACTIVE on a day (GET /api/ilmoitustaulu). Any company member. " +
        "--date takes today|yesterday|tomorrow or YYYYMMDD (defaults to today).")
        .option("--date <d>", "Day to query: today|yesterday|tomorrow|YYYYMMDD (default today)")
        .action(async (opts) => {
        const date = toBoardQueryDate(opts.date);
        if (!date) {
            failWith(`Invalid --date "${opts.date}" — use today|yesterday|tomorrow or YYYYMMDD`, 4);
        }
        try {
            const client = await getClient();
            writeJson(await runBoardList(client, date));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    b.command("all")
        .description("List EVERY notice incl. expired/scheduled (GET /api/ilmoitustaulu/all). " +
        "Requires isAsiakasAdmin/isAsiakasEditor or isIlmoitustauluEditor.")
        .action(async () => {
        try {
            const client = await getClient();
            writeJson(await runBoardAll(client));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    b.command("get <messageId>")
        .description("Get one notice by id (no single-GET route — filtered client-side over /all, " +
        "so it needs the same admin/editor access). Unknown id → exit 5.")
        .action(async (raw) => {
        const messageId = parseMessageId(raw);
        try {
            const client = await getClient();
            const row = await runBoardGet(client, messageId);
            if (!row)
                failWith(`No board message with id ${messageId}`, 5);
            writeJson(row);
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const createCmd = b
        .command("create")
        .description("Create a notice (POST /api/ilmoitustaulu). --title, --text and --start-date " +
        "are required; --priority defaults to info; --expires-at is optional (omit = never). " +
        "--reason required. --dry-run previews the payload CLIENT-SIDE without writing. " +
        "Requires admin/editor.")
        .requiredOption("--title <s>", "Notice title")
        .requiredOption("--text <s>", "Notice body text")
        .option("--priority <p>", `Priority: ${PRIORITIES.join("|")} (default info)`)
        .option("--start-date <d>", "Day the notice becomes visible: today|YYYY-MM-DD")
        .option("--expires-at <d>", "Last day visible: YYYY-MM-DD (omit = never expires)");
    addWriteFlagsToCommand(createCmd).action(async (opts) => {
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        if (!opts.startDate)
            failWith("Missing required flag: --start-date", 4);
        assertPriority(opts.priority);
        try {
            const client = await getClient();
            const fields = buildBoardFields(opts);
            writeJson(await runBoardCreate(client, fields, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const updateCmd = b
        .command("update <messageId>")
        .description("Update a notice (PUT /api/ilmoitustaulu/:messageId). GET-merges the current " +
        "row so omitted fields are preserved (the backend overwrites the whole row). " +
        "--reason required. --dry-run previews the merged row CLIENT-SIDE without writing " +
        "(no server X-Dry-Run guard). Admins edit any row; editors only their own.")
        .option("--title <s>", "Notice title")
        .option("--text <s>", "Notice body text")
        .option("--priority <p>", `Priority: ${PRIORITIES.join("|")}`)
        .option("--start-date <d>", "Day the notice becomes visible: today|YYYY-MM-DD")
        .option("--expires-at <d>", 'Last day visible: YYYY-MM-DD (pass "" to clear the expiry)');
    addWriteFlagsToCommand(updateCmd).action(async (raw, opts) => {
        const messageId = parseMessageId(raw);
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        assertPriority(opts.priority);
        try {
            const client = await getClient();
            const fields = buildBoardFields(opts);
            writeJson(await runBoardUpdate(client, messageId, fields, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const deleteCmd = b
        .command("delete <messageId>")
        .description("Delete a notice (DELETE /api/ilmoitustaulu/:messageId). --reason required. " +
        "--dry-run previews what would be deleted CLIENT-SIDE without writing. " +
        "Admins delete any row; editors only their own.");
    addWriteFlagsToCommand(deleteCmd).action(async (raw, opts) => {
        const messageId = parseMessageId(raw);
        if (!opts.dryRun && !opts.reason)
            failWith("Missing required flag: --reason", 4);
        try {
            const client = await getClient();
            writeJson(await runBoardDelete(client, messageId, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
// ─── CommandSpecs (co-located: one source of truth for this sub-group). ───────
// Spread into COMMAND_SPECS in reference/specs.ts; `registerMessageBoardCommands`
// wires the matching leaves into the `ib message` umbrella in commands/message. ──
const BOARD_AUTH_ERRORS = [
    { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
    {
        http: 403,
        exit: 3,
        meaning: "Not an admin/editor (writes + `all`/`get` require it)",
        remedy: "an asiakas admin/editor or ilmoitustaulu editor must run it",
    },
    {
        http: 400,
        exit: 4,
        meaning: "Validation error (missing title/text/start-date, bad priority/date)",
        remedy: "check the flags",
    },
    { http: 500, exit: 6, meaning: "Backend error", remedy: "retry with --verbose" },
];
const BOARD_NOT_FOUND = {
    http: 404,
    exit: 5,
    meaning: "No notice with that id for the company",
    remedy: "ib message board all",
};
const BOARD_ROW = "{ messageId, ownerAsiakasId, title, body, priority, startDate, expiresAt, createdAt, updatedAt, createdBy }";
const BOARD_EDIT_PERMS = ["auth.page.ilmoitustaulu.edit", "auth.page.ilmoitustaulu.editOwn"];
export const MESSAGE_BOARD_SPECS = [
    {
        command: "ib message board list",
        description: "List notices ACTIVE on a day (startDate ≤ day ≤ expiresAt, or no expiry), newest first. Open to any company member. --date takes today/yesterday/tomorrow or YYYYMMDD (defaults to today). The web UI's per-device dismiss state is NOT applied — the CLI returns the full active set.",
        auth: "any",
        flags: [
            {
                name: "date",
                type: "date",
                description: "Day to query: today | yesterday | tomorrow | YYYYMMDD (default today)",
            },
        ],
        outputShape: `ListEnvelope<${BOARD_ROW}>`,
        errors: BOARD_AUTH_ERRORS,
        notes: [
            "Requires the ilmoitustaulu module enabled for the company.",
            "The active-list endpoint uses compact YYYYMMDD (not ISO) — the CLI converts for you.",
        ],
        seeAlso: ["ib message board all", "ib message board get"],
        examples: ["ib message board list", "ib message board list --date 20260614"],
    },
    {
        command: "ib message board all",
        description: "List EVERY notice for the company including expired and not-yet-started ones (the admin-panel view). Requires an asiakas admin/editor or ilmoitustaulu editor.",
        permissions: BOARD_EDIT_PERMS,
        flags: [],
        outputShape: `ListEnvelope<${BOARD_ROW}>`,
        errors: BOARD_AUTH_ERRORS,
        seeAlso: ["ib message board list"],
        examples: ["ib message board all"],
    },
    {
        command: "ib message board get",
        description: "Get one notice by id. There is no single-message GET route, so it is resolved CLIENT-SIDE over `all` — and therefore needs the same admin/editor access. Unknown id → exit 5.",
        permissions: BOARD_EDIT_PERMS,
        args: [{ name: "messageId", type: "number", description: "Notice to fetch" }],
        flags: [],
        outputShape: BOARD_ROW,
        errors: [BOARD_NOT_FOUND, ...BOARD_AUTH_ERRORS],
        examples: ["ib message board get 7"],
    },
    {
        command: "ib message board create",
        description: "Create a notice (POST). --title, --text and --start-date are required; --priority defaults to info; --expires-at is optional (omit = never expires). Requires admin/editor. --reason required.",
        permissions: BOARD_EDIT_PERMS,
        flags: [
            { name: "title", type: "string", required: true, description: "Notice title" },
            { name: "text", type: "string", required: true, description: "Notice body text (stored as body)" },
            { name: "priority", type: "string", description: "info | warning | urgent (default info)" },
            {
                name: "start-date",
                type: "date",
                description: "Day the notice becomes visible: today | YYYY-MM-DD (required)",
            },
            {
                name: "expires-at",
                type: "date",
                description: "Last day visible: YYYY-MM-DD (omit = never expires)",
            },
        ],
        writeFlags: true,
        mutates: true,
        outputShape: `${BOARD_ROW} · { dryRun: true, proposed: {...} } on --dry-run`,
        errors: BOARD_AUTH_ERRORS,
        notes: [
            "--dry-run previews the payload CLIENT-SIDE without writing (the route has no X-Dry-Run guard).",
        ],
        seeAlso: ["ib message board update", "ib message board delete"],
        examples: [
            'ib message board create --title "Asema kiinni" --text "Perjantaina suljettu" --start-date today --priority warning --reason "tiedote"',
        ],
    },
    {
        command: "ib message board update",
        description: "Update a notice (PUT). GET-merges the current row (over `all`) so omitted fields are preserved — the backend overwrites the whole row. Admins edit any row; editors only their own. --reason required.",
        permissions: BOARD_EDIT_PERMS,
        args: [{ name: "messageId", type: "number", description: "Notice to update" }],
        flags: [
            { name: "title", type: "string", description: "Notice title" },
            { name: "text", type: "string", description: "Notice body text (stored as body)" },
            { name: "priority", type: "string", description: "info | warning | urgent" },
            {
                name: "start-date",
                type: "date",
                description: "Day the notice becomes visible: today | YYYY-MM-DD",
            },
            {
                name: "expires-at",
                type: "date",
                description: 'Last day visible: YYYY-MM-DD (pass "" to clear the expiry)',
            },
        ],
        writeFlags: true,
        mutates: true,
        outputShape: `${BOARD_ROW} · { dryRun: true, messageId, current, proposed } on --dry-run`,
        errors: [BOARD_NOT_FOUND, ...BOARD_AUTH_ERRORS],
        notes: [
            "--dry-run previews the merged row CLIENT-SIDE without writing (no server X-Dry-Run guard).",
        ],
        seeAlso: ["ib message board get"],
        examples: ['ib message board update 7 --priority urgent --reason "nostettu kiireelliseksi"'],
    },
    {
        command: "ib message board delete",
        description: "Delete a notice (DELETE, 204). Admins delete any row; editors only their own. --reason required.",
        permissions: BOARD_EDIT_PERMS,
        args: [{ name: "messageId", type: "number", description: "Notice to delete" }],
        flags: [],
        writeFlags: true,
        mutates: true,
        outputShape: "204 no content · { dryRun: true, messageId, wouldDelete: {...} } on --dry-run",
        errors: [BOARD_NOT_FOUND, ...BOARD_AUTH_ERRORS],
        notes: ["--dry-run previews what would be deleted CLIENT-SIDE without writing."],
        examples: ['ib message board delete 7 --reason "vanhentunut"'],
    },
];
//# sourceMappingURL=index.js.map