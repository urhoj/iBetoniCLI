import { CliError } from "../../../api/errors.js";
import { writeJson, exitWithError } from "../../../output/json.js";
import { parseId } from "../../../targets.js";
const STATUSES = ["open", "resolved", "all"];
const CONTEXT_TYPES = ["pumppuRequest", "keikka"];
/**
 * GET /api/messages/support/inbox — developer-only triage queue. Projects the
 * backend `{ items, count, truncated }` into the universal list envelope.
 */
export async function runSupportInbox(client, opts) {
    const status = opts.status ?? "open";
    if (!STATUSES.includes(status)) {
        throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
    }
    const qs = new URLSearchParams();
    qs.set("status", status);
    if (opts.limit !== undefined)
        qs.set("limit", String(opts.limit));
    const res = await client.get(`/api/messages/support/inbox?${qs.toString()}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    return {
        items,
        nextCursor: null,
        count: typeof res?.count === "number" ? res.count : items.length,
        truncated: Boolean(res?.truncated),
    };
}
/**
 * GET /api/messages/support/mine — the CALLER's own company's support threads
 * (operator-facing companion to the developer-only inbox; any member of the
 * owning company may list them). Projects the backend `{ items, count,
 * truncated }` into the universal list envelope.
 */
export async function runSupportMine(client, opts) {
    const status = opts.status ?? "open";
    if (!STATUSES.includes(status)) {
        throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
    }
    const qs = new URLSearchParams();
    qs.set("status", status);
    if (opts.limit !== undefined)
        qs.set("limit", String(opts.limit));
    const res = await client.get(`/api/messages/support/mine?${qs.toString()}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    return {
        items,
        nextCursor: null,
        count: typeof res?.count === "number" ? res.count : items.length,
        truncated: Boolean(res?.truncated),
    };
}
/**
 * POST /api/messages/support — open (or append to) a support thread. A REAL
 * write: NOT sent as meta, so the read-only write-lock blocks it. `--dry-run`
 * resolves client-side (prints the payload, never POSTs).
 */
export async function runSupportContact(client, input) {
    if (!CONTEXT_TYPES.includes(input.contextType)) {
        throw new CliError(`contextType must be one of: ${CONTEXT_TYPES.join(", ")} (set --keikka or --tarjous)`, 400, null, 4);
    }
    if (!Number.isFinite(input.contextId) || input.contextId <= 0) {
        throw new CliError("contextId must be a positive number (--keikka or --tarjous)", 400, null, 4);
    }
    const body = String(input.body ?? "").trim();
    if (!body) {
        throw new CliError("--body cannot be empty", 400, null, 4);
    }
    const payload = {
        contextType: input.contextType,
        contextId: input.contextId,
        body,
    };
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "POST", path: "/api/messages/support", body: payload } };
    }
    return client.post("/api/messages/support", payload);
}
/**
 * PATCH /api/messages/support/:threadId/status — developer-only. Marks the
 * support thread resolved (or `--reopen` → open). A REAL write (blocked under
 * --read-only); `--dry-run` previews the body client-side without sending.
 */
export async function runSupportResolve(client, threadId, input) {
    if (!Number.isFinite(threadId) || threadId <= 0) {
        throw new CliError("threadId must be a positive number", 400, null, 4);
    }
    const status = input.reopen ? "open" : "resolved";
    const path = `/api/messages/support/${threadId}/status`;
    if (input.dryRun) {
        return { dryRun: true, wouldSend: { method: "PATCH", path, body: { status } } };
    }
    return client.patch(path, { status });
}
/**
 * Register `ib message support` — the Operator → platform escalation lifecycle:
 *   contact   POST /api/messages/support           (any user; a real write)
 *   inbox     GET  /api/messages/support/inbox      (developer-only)
 *   resolve   PATCH /api/messages/support/:id/status (developer-only; a write)
 *
 * Read/reply with the existing `ib message chat list/send <threadId>`.
 */
export function registerMessageSupportCommands(parent, getClient) {
    const support = parent
        .command("support")
        .description("Operator → platform support escalations");
    support
        .command("inbox")
        .description("Support triage queue (developer-only): open | resolved | all")
        .option("--status <status>", "open | resolved | all", "open")
        .option("--limit <n>", "Max rows", Number)
        .action(async (opts) => {
        try {
            writeJson(await runSupportInbox(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    support
        .command("mine")
        .description("Your own company's support threads (open | resolved | all)")
        .option("--status <status>", "open | resolved | all", "open")
        .option("--limit <n>", "Max rows", Number)
        .action(async (opts) => {
        try {
            writeJson(await runSupportMine(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    support
        .command("contact")
        .description("Open (or append to) a support thread about a tarjous or keikka. A real write; --dry-run previews the payload CLIENT-SIDE (no POST). Reply later with `ib message chat send <threadId>`.")
        .option("--tarjous <id>", "pumppuRequestId this escalation is about", Number)
        .option("--keikka <id>", "keikkaId this escalation is about", Number)
        .requiredOption("--body <text>", "The message to support")
        // client-side --dry-run (the /support routes have no server X-Dry-Run guard); no
        // audit headers — contact persists no reason and ensureSupportThread is idempotent.
        .option("--dry-run", "Print the payload without sending (client-side)")
        .action(async (opts) => {
        try {
            // Number-coerced flags turn "abc" into NaN (which is !== undefined), so a
            // bare presence check would skip this guard and fire a misleading downstream
            // error. Gate on finiteness instead. (run* keeps its own guard as defence.)
            const contextId = Number.isFinite(opts.keikka) ? opts.keikka : opts.tarjous;
            if (!Number.isFinite(contextId)) {
                throw new CliError("Provide --keikka or --tarjous (positive integer)", 400, null, 4);
            }
            const contextType = Number.isFinite(opts.keikka) ? "keikka" : "pumppuRequest";
            writeJson(await runSupportContact(await getClient(), {
                contextType,
                contextId: contextId,
                body: opts.body,
                dryRun: opts.dryRun,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    support
        .command("resolve <threadId>")
        .description("Mark a support thread resolved, or --reopen it (developer-only; a write). --dry-run previews the body client-side.")
        .option("--reopen", "Set status back to open instead of resolved")
        // client-side --dry-run (the status PATCH has no server X-Dry-Run guard); no
        // audit headers — the status change persists no reason.
        .option("--dry-run", "Print the update body without sending (client-side)")
        .action(async (threadIdStr, opts) => {
        try {
            writeJson(await runSupportResolve(await getClient(), parseId(threadIdStr, "threadId"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map