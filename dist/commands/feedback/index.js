import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { parseId } from "../../targets.js";
const KINDS = ["improvement", "bug", "idea", "legal"];
const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "other"];
const STATUSES = ["open", "reviewed", "applied", "dismissed"];
const MAX_FREETEXT = 200;
const CAP = 200;
const TRUNCATED_FIELDS = ["description", "resolution", "errorText"];
const TRUNCATE_HINT = "description/resolution truncated to 200 chars; ib feedback get <id> for full text";
/** Cap a string at MAX_FREETEXT chars, appending "..." when cut. Non-strings
 * pass through untouched. */
function truncateField(v) {
    if (typeof v === "string" && v.length > MAX_FREETEXT) {
        return { value: v.slice(0, MAX_FREETEXT) + "...", cut: true };
    }
    return { value: v, cut: false };
}
/** Shallow-copy a feedback row with its long free-text fields capped. */
function compactRow(row) {
    const out = { ...row };
    let cut = false;
    for (const f of TRUNCATED_FIELDS) {
        if (f in out) {
            const t = truncateField(out[f]);
            out[f] = t.value;
            if (t.cut)
                cut = true;
        }
    }
    return { row: out, cut };
}
/** Build the query string and GET a page of feedback rows (always an array). */
async function fetchRows(client, params) {
    const qs = new URLSearchParams();
    if (params.status)
        qs.set("status", params.status);
    if (params.kind)
        qs.set("kind", params.kind);
    if (params.scope)
        qs.set("scope", params.scope);
    if (params.search)
        qs.set("search", params.search);
    if (params.limit !== undefined)
        qs.set("limit", String(params.limit));
    if (params.offset !== undefined)
        qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const rows = await client.get(`/api/feedback${suffix}`);
    return Array.isArray(rows) ? rows : [];
}
function buildCreateBody(input) {
    const description = input.description?.trim();
    if (!description) {
        throw new CliError("description is required", 400, null, 4);
    }
    if (input.scope !== undefined && !SCOPES.includes(input.scope)) {
        throw new CliError(`--scope must be one of: ${SCOPES.join(", ")}`, 400, null, 4);
    }
    const body = {
        kind: KINDS.includes(input.kind) ? input.kind : "improvement",
        scope: input.scope ?? "cli",
        description,
    };
    if (input.command)
        body.command = input.command;
    if (input.error)
        body.error = input.error;
    const convId = Number(process.env.IB_CONVERSATION_ID);
    if (Number.isInteger(convId) && convId > 0) {
        body.context = { conversationId: convId };
    }
    return body;
}
/**
 * POST /api/feedback — file a proposal / trouble report. `meta: true` exempts it
 * from the read-only write-lock. `--dry-run` prints the payload and never POSTs.
 */
export async function runFeedbackCreate(client, input) {
    const body = buildCreateBody(input);
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "POST", path: "/api/feedback", body } };
    }
    return client.post("/api/feedback", body, { meta: true });
}
/**
 * Resolve the requested status filter into a list of statuses, or null for no
 * filter. `--unresolved` = open + reviewed. `--status` may be a single value or
 * a comma-separated list. Conflicting/unknown values exit 4.
 */
function resolveStatuses(opts) {
    if (opts.unresolved && opts.status) {
        throw new CliError("Use either --unresolved or --status, not both", 400, null, 4);
    }
    if (opts.unresolved)
        return ["open", "reviewed"];
    if (opts.status) {
        const list = opts.status
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        for (const s of list) {
            if (!STATUSES.includes(s)) {
                throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
            }
        }
        return list.length ? list : null;
    }
    return null;
}
/**
 * GET /api/feedback — developer-only. One status (or none) is a single
 * server-filtered GET. `--unresolved` / a CSV `--status` fan out to one GET per
 * status, merged newest-first and sliced [offset, offset+limit) client-side.
 * Long free-text is capped at 200 chars unless `--full`.
 */
export async function runFeedbackList(client, opts) {
    const statuses = resolveStatuses(opts);
    let items;
    let truncated = false;
    if (!statuses || statuses.length <= 1) {
        items = await fetchRows(client, {
            status: statuses?.[0],
            kind: opts.kind,
            scope: opts.scope,
            search: opts.search,
            limit: opts.limit,
            offset: opts.offset,
        });
    }
    else {
        const pages = await Promise.all(statuses.map((s) => fetchRows(client, { status: s, kind: opts.kind, scope: opts.scope, search: opts.search, limit: CAP })));
        if (pages.some((p) => p.length >= CAP))
            truncated = true;
        const merged = pages
            .flat()
            .sort((a, b) => Number(b.feedbackId) - Number(a.feedbackId));
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? 50;
        if (merged.length > offset + limit)
            truncated = true;
        items = merged.slice(offset, offset + limit);
    }
    let cut = false;
    if (!opts.full) {
        items = items.map((r) => {
            const c = compactRow(r);
            if (c.cut)
                cut = true;
            return c.row;
        });
    }
    const env = {
        items,
        nextCursor: null,
        count: items.length,
    };
    if (truncated)
        env.truncated = true;
    if (cut)
        env.hint = TRUNCATE_HINT;
    return env;
}
/** GET /api/feedback/:id — developer-only single row. */
export async function runFeedbackGet(client, id) {
    return client.get(`/api/feedback/${id}`);
}
/**
 * Client-side aggregate of /api/feedback for the cheapest "is there anything?"
 * answer. Fetches up to the 200-row cap (optionally pre-filtered by
 * kind/scope) and buckets by status/kind/scope. Flags `truncated` if the table
 * exceeds the cap (won't happen at current row counts; kept honest).
 */
export async function runFeedbackCount(client, opts) {
    const rows = await fetchRows(client, { kind: opts.kind, scope: opts.scope, limit: CAP });
    const byStatus = { open: 0, reviewed: 0, applied: 0, dismissed: 0 };
    const byKind = {};
    const byScope = {};
    for (const r of rows) {
        const s = String(r.status ?? "");
        if (s in byStatus)
            byStatus[s] += 1;
        const k = String(r.kind ?? "unknown");
        byKind[k] = (byKind[k] ?? 0) + 1;
        const sc = String(r.scope ?? "unknown");
        byScope[sc] = (byScope[sc] ?? 0) + 1;
    }
    const out = { total: rows.length, byStatus, byKind, byScope };
    if (rows.length >= CAP) {
        out.truncated = true;
        out.hint = "count is a lower bound — fetch hit the 200-row cap";
    }
    return out;
}
/** Project a resolved row to the compact write-ack fields (resolution capped). */
function compactAck(row) {
    const ack = {};
    for (const k of ["feedbackId", "status", "updatedAt"]) {
        if (k in row)
            ack[k] = row[k];
    }
    if ("resolution" in row)
        ack.resolution = truncateField(row.resolution).value;
    return ack;
}
/**
 * PUT /api/feedback/:id — developer triage (status and/or resolution note).
 * A REAL write — blocked under --read-only (exit 3). `--dry-run` previews the
 * body client-side without sending.
 */
export async function runFeedbackResolve(client, id, input) {
    if (input.status !== undefined && !STATUSES.includes(input.status)) {
        throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
    }
    if (input.status === undefined && input.note === undefined) {
        throw new CliError("Provide --status and/or --note", 400, null, 4);
    }
    const body = {};
    if (input.status !== undefined)
        body.status = input.status;
    if (input.note !== undefined)
        body.resolution = input.note;
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
    }
    const row = await client.put(`/api/feedback/${id}`, body);
    return input.full ? row : compactAck(row);
}
/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; a real write)
 */
export function registerFeedbackCommands(parent, getClient, opts = {}) {
    const f = parent
        .command("feedback", { hidden: !!opts.hidden })
        .description("File & triage CLI improvement proposals / trouble reports");
    f.command("create <description>")
        .description("File a proposal/trouble report. Silent server-side; works under --read-only.")
        .option("--kind <kind>", "improvement | bug | idea | legal", "improvement")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | other — product surface this feedback targets", "cli")
        .option("--command <argv>", "The ib command/argv that triggered the friction")
        .option("--error <msg>", "Error message you hit, if any")
        .option("--dry-run", "Print the payload without sending (client-side)")
        .action(async (description, opts) => {
        try {
            const client = await getClient();
            writeJson(await runFeedbackCreate(client, { description, ...opts }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    f.command("list")
        .description("List feedback for triage (developer-only)")
        .option("--status <status>", "open | reviewed | applied | dismissed (or a comma-separated list, e.g. open,reviewed)")
        .option("--unresolved", "Shortcut for --status open,reviewed (un-closed items)")
        .option("--full", "Return untruncated description/resolution (default: capped at 200 chars)")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | other")
        .option("--search <text>", "Substring match over description/command/resolution/errorText (deploy-gated)")
        .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
        .option("--offset <n>", "Pagination offset", Number)
        .action(async (opts) => {
        try {
            writeJson(await runFeedbackList(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    f.command("get <id>")
        .description("Fetch one feedback row by id (developer-only)")
        .action(async (idStr) => {
        try {
            writeJson(await runFeedbackGet(await getClient(), parseId(idStr, "feedbackId")));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    f.command("resolve <id>")
        .description("Triage a feedback row: set status and/or note (developer-only; a write)")
        .option("--status <status>", "open | reviewed | applied | dismissed")
        .option("--note <text>", "Resolution note stored on the row")
        .option("--dry-run", "Print the update body without sending (client-side)")
        .option("--full", "Return the full updated row (default: a compact ack)")
        .action(async (idStr, opts) => {
        try {
            writeJson(await runFeedbackResolve(await getClient(), parseId(idStr, "feedbackId"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    f.command("count")
        .description("Counts of feedback by status/kind/scope (developer-only)")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | other")
        .action(async (opts) => {
        try {
            writeJson(await runFeedbackCount(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map