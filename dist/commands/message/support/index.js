import { failWith, writeJson } from "../../../output/json.js";
import { assertEnum, parseId } from "../../../targets.js";
import { jsonAction, guarded } from "../../_shared/action.js";
import { qs } from "../../../api/query.js";
const STATUSES = ["open", "resolved", "all"];
const CONTEXT_TYPES = ["pumppuRequest", "keikka"];
/**
 * GET /api/messages/support/<view> — projects the backend
 * `{ items, count, truncated }` into the universal list envelope.
 */
async function fetchSupportThreads(client, view, opts) {
    const status = opts.status ?? "open";
    assertEnum(status, STATUSES, "--status");
    const res = await client.get(`/api/messages/support/${view}${qs({ status, limit: opts.limit })}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    return {
        items,
        nextCursor: null,
        count: typeof res?.count === "number" ? res.count : items.length,
        truncated: Boolean(res?.truncated),
    };
}
/** GET /api/messages/support/inbox — developer-only triage queue. */
export const runSupportInbox = (client, opts) => fetchSupportThreads(client, "inbox", opts);
/**
 * GET /api/messages/support/mine — the CALLER's own company's support threads
 * (operator-facing companion to the developer-only inbox; any member of the
 * owning company may list them).
 */
export const runSupportMine = (client, opts) => fetchSupportThreads(client, "mine", opts);
/**
 * POST /api/messages/support — open (or append to) a support thread. A REAL
 * write: NOT sent as meta, so the read-only write-lock blocks it. `--dry-run`
 * resolves client-side (prints the payload, never POSTs).
 */
export async function runSupportContact(client, input) {
    if (!CONTEXT_TYPES.includes(input.contextType)) {
        failWith(`contextType must be one of: ${CONTEXT_TYPES.join(", ")} (set --keikka or --tarjous)`, 4);
    }
    if (!Number.isFinite(input.contextId) || input.contextId <= 0) {
        failWith("contextId must be a positive number (--keikka or --tarjous)", 4);
    }
    const body = String(input.body ?? "").trim();
    if (!body) {
        failWith("--body cannot be empty", 4);
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
        failWith("threadId must be a positive number", 4);
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
        .option("--status <status>", "", "open")
        .option("--limit <n>", "", Number)
        .action(jsonAction(getClient, (client, opts) => runSupportInbox(client, opts)));
    support
        .command("mine")
        .option("--status <status>", "", "open")
        .option("--limit <n>", "", Number)
        .action(jsonAction(getClient, (client, opts) => runSupportMine(client, opts)));
    support
        .command("contact")
        .option("--tarjous <id>", "", Number)
        .option("--keikka <id>", "", Number)
        .requiredOption("--body <text>")
        // client-side --dry-run (the /support routes have no server X-Dry-Run guard); no
        // audit headers — contact persists no reason and ensureSupportThread is idempotent.
        .option("--dry-run")
        .action(guarded(async (opts) => {
        // Number-coerced flags turn "abc" into NaN (which is !== undefined), so a
        // bare presence check would skip this guard and fire a misleading downstream
        // error. Gate on finiteness instead. (run* keeps its own guard as defence.)
        const contextId = Number.isFinite(opts.keikka) ? opts.keikka : opts.tarjous;
        if (!Number.isFinite(contextId)) {
            failWith("Provide --keikka or --tarjous (positive integer)", 4);
        }
        const contextType = Number.isFinite(opts.keikka) ? "keikka" : "pumppuRequest";
        writeJson(await runSupportContact(await getClient(), {
            contextType,
            contextId: contextId,
            body: opts.body,
            dryRun: opts.dryRun,
        }));
    }));
    support
        .command("resolve <threadId>")
        .option("--reopen")
        // client-side --dry-run (the status PATCH has no server X-Dry-Run guard); no
        // audit headers — the status change persists no reason.
        .option("--dry-run")
        .action(jsonAction(getClient, (client, threadIdStr, opts) => runSupportResolve(client, parseId(threadIdStr, "threadId"), opts)));
}
//# sourceMappingURL=index.js.map