import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
const KINDS = ["improvement", "bug", "idea", "legal"];
const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "other"];
const STATUSES = ["open", "reviewed", "applied", "dismissed"];
const MAX_FREETEXT = 200;
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
 * GET /api/feedback — developer-only. Projects rows into the `{ items,
 * nextCursor, count }` envelope. Long free-text (description/resolution/
 * errorText) is capped at 200 chars unless `--full`; when anything was cut the
 * envelope carries a `hint` pointing at `ib feedback get <id>`.
 */
export async function runFeedbackList(client, opts) {
    let items = await fetchRows(client, opts);
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
    if (cut)
        env.hint = TRUNCATE_HINT;
    return env;
}
/** GET /api/feedback/:id — developer-only single row. */
export async function runFeedbackGet(client, id) {
    return client.get(`/api/feedback/${id}`);
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
    return client.put(`/api/feedback/${id}`, body);
}
/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; a real write)
 */
export function registerFeedbackCommands(parent, getClient) {
    const f = parent
        .command("feedback")
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
        .option("--status <status>", "open | reviewed | applied | dismissed")
        .option("--kind <kind>", "improvement | bug | idea | legal")
        .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | other")
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
            writeJson(await runFeedbackGet(await getClient(), Number(idStr)));
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
        .action(async (idStr, opts) => {
        try {
            writeJson(await runFeedbackResolve(await getClient(), Number(idStr), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map