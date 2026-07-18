import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../../output/json.js";
import { resolveThreadId } from "./resolveThread.js";
import { parseOptionalId, resolveSearchQuery } from "../../../targets.js";
/** Wrap a backend array into the universal `{ items, nextCursor, count }` envelope. */
function toEnvelope(value) {
    const items = Array.isArray(value) ? value : [];
    return { items, nextCursor: null, count: items.length };
}
/**
 * GET /api/messages/threads/mine → your threads (inbox), newest first.
 * `--tarjous` filters to one pumppuRequest; `--unread` to unreadCount > 0.
 * Both filters are client-side (the route returns the full participant set).
 */
export async function runChatThreads(client, opts) {
    const rows = await client.get("/api/messages/threads/mine");
    let items = Array.isArray(rows) ? rows : [];
    if (opts.tarjous !== undefined) {
        items = items.filter((r) => r.contextType === "pumppuRequest" && Number(r.contextId) === opts.tarjous);
    }
    if (opts.unread)
        items = items.filter((r) => Number(r.unreadCount) > 0);
    return { items, nextCursor: null, count: items.length };
}
/** GET /api/messages/threads/:id → thread metadata + participants. */
export async function runChatThread(client, threadId) {
    return client.get(`/api/messages/threads/${threadId}`);
}
/**
 * GET /api/messages/threads/:id/messages → messages, oldest first. Does NOT
 * mark the thread read. `--since` backfills (ISO); `--limit` caps (server max 500).
 * `--deleted` adds `?includeDeleted=1` (own deleted rows; all rows for developers).
 */
export async function runChatList(client, threadId, opts) {
    const params = new URLSearchParams();
    if (opts.deleted)
        params.set("includeDeleted", "1");
    if (opts.since)
        params.set("since", opts.since);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    return toEnvelope(await client.get(`/api/messages/threads/${threadId}/messages${qs ? `?${qs}` : ""}`));
}
/**
 * GET /api/messages/search?q=&limit= — search the caller's own messages by body
 * text across all their threads, newest first. Read-only. Uses manual
 * encodeURIComponent (the backend qs parser does not decode "+" to a space).
 */
export async function runChatSearch(client, query, opts) {
    const parts = [`q=${encodeURIComponent(query)}`];
    if (opts.limit !== undefined)
        parts.push(`limit=${opts.limit}`);
    return toEnvelope(await client.get(`/api/messages/search?${parts.join("&")}`));
}
/**
 * POST /api/messages/threads/:id/messages — send a message.
 *
 * `--dry-run` is CLIENT-SIDE: the route has no X-Dry-Run guard
 * ([[feedback_ib_dryrun_deploy_gated]]), so a "dry-run" that POSTed would
 * actually send. Instead we GET the thread participants and return a preview of
 * the body + who would receive it, issuing NO write (works under --read-only).
 * A real send POSTs { body, source, sourceNote? }; the non-GET is naturally
 * blocked by the read-only write-lock when active.
 */
export async function runChatSend(client, threadId, opts) {
    if (opts.dryRun) {
        const meta = await client.get(`/api/messages/threads/${threadId}`);
        const recipients = (meta.participants ?? []).map((p) => ({
            personId: p.personId,
            name: `${p.personFirstName ?? ""} ${p.personLastName ?? ""}`.trim(),
            role: p.role,
        }));
        return {
            dryRun: true,
            threadId,
            wouldSend: {
                body: opts.body,
                source: opts.source,
                sourceNote: opts.reason ?? null,
                recipients,
            },
        };
    }
    const payload = { body: opts.body, source: opts.source };
    if (opts.reason)
        payload.sourceNote = opts.reason;
    return client.post(`/api/messages/threads/${threadId}/messages`, payload, {
        headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }),
    });
}
/** POST /api/messages/threads/:id/read — stamp the caller's lastReadAt to now. */
export async function runChatMarkRead(client, threadId) {
    return client.post(`/api/messages/threads/${threadId}/read`, {});
}
/**
 * DELETE /api/messages/threads/:id/messages/:messageId — soft-delete a message.
 *
 * `--dry-run` is CLIENT-SIDE: it lists the thread (a GET, so it works under
 * --read-only) and echoes the target as `wouldDelete`, issuing NO delete — the
 * route has no X-Dry-Run guard, so a "dry-run" that DELETEd would really delete.
 * A miss → exit 5. A real delete issues DELETE with the write-safety headers and
 * is naturally blocked by the read-only write-lock. Server-side the author may
 * delete only an unanswered own message; a developer may moderate any.
 */
export async function runChatDelete(client, threadId, messageId, opts) {
    if (opts.dryRun) {
        const list = await runChatList(client, threadId, {});
        const target = list.items.find((m) => Number(m.messageId) === messageId);
        if (!target)
            failWith(`Message ${messageId} not found in thread ${threadId}`, 5);
        return {
            dryRun: true,
            threadId,
            wouldDelete: {
                messageId,
                body: target.body ?? null,
                senderPersonId: target.senderPersonId ?? null,
            },
        };
    }
    return client.delete(`/api/messages/threads/${threadId}/messages/${messageId}`, { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) });
}
/**
 * PATCH /api/messages/threads/:id/messages/:messageId — edit a message body.
 *
 * `--dry-run` is CLIENT-SIDE: lists the thread, finds the target, returns the
 * from→to diff without issuing the PATCH (works under --read-only). A miss →
 * exit 5. Server-side this is author-only and only while unanswered.
 */
export async function runChatEdit(client, threadId, messageId, opts) {
    if (opts.dryRun) {
        const list = await runChatList(client, threadId, {});
        const target = list.items.find((m) => Number(m.messageId) === messageId);
        if (!target)
            failWith(`Message ${messageId} not found in thread ${threadId}`, 5);
        return {
            dryRun: true,
            threadId,
            wouldEdit: { messageId, from: target.body ?? null, to: opts.body },
        };
    }
    return client.patch(`/api/messages/threads/${threadId}/messages/${messageId}`, { body: opts.body }, { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) });
}
/**
 * POST /api/messages/threads/:id/messages/:messageId/restore — un-soft-delete.
 *
 * `--dry-run` is CLIENT-SIDE: lists deleted messages (?includeDeleted=1), finds
 * the target, returns wouldRestore without POSTing (works under --read-only). A
 * miss → exit 5. Server-side: author or sysadmin/developer.
 */
export async function runChatRestore(client, threadId, messageId, opts) {
    if (opts.dryRun) {
        const list = await runChatList(client, threadId, { deleted: true });
        const target = list.items.find((m) => Number(m.messageId) === messageId);
        if (!target)
            failWith(`Message ${messageId} not found among deleted in thread ${threadId}`, 5);
        return { dryRun: true, threadId, wouldRestore: { messageId } };
    }
    return client.post(`/api/messages/threads/${threadId}/messages/${messageId}/restore`, {}, { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) });
}
/** Resolve the {@link ThreadTarget} from a positional + --tarjous option. */
function targetFrom(threadIdStr, opts) {
    return {
        thread: parseOptionalId(threadIdStr, "threadId"),
        tarjous: opts.tarjous,
    };
}
/**
 * Register `ib message chat` — conversational threads over /api/messages/*:
 *   threads              inbox (your threads, unread + last-message preview)
 *   thread [id]          one thread's meta + participants
 *   list [id]            messages in a thread (does NOT mark read); --deleted includes soft-deleted
 *   search <query>       search your own messages by body text across all threads (newest first)
 *   send [id] --body     send a message (client-side --dry-run; --reason→sourceNote)
 *   mark-read [id]       stamp lastReadAt
 *   delete <messageId>   soft-delete a message (author-if-unanswered / dev moderation)
 *   edit <messageId>     edit message body (author-if-unanswered; client-side --dry-run)
 *   restore <messageId>  un-soft-delete a message (author or developer; client-side --dry-run)
 *
 * Every thread-targeting leaf accepts a raw threadId OR --tarjous <pumppuRequestId>.
 * send/mark-read/delete/edit/restore are writes (blocked under --read-only by the client write-lock).
 */
export function registerMessageChatCommands(parent, getClient) {
    const c = parent
        .command("chat")
        .description("Conversational message threads (Jerry tarjous now, keikka later)");
    c.command("threads")
        .description("List your message threads (inbox), newest first")
        .option("--unread", "Only threads with unread messages")
        .option("--tarjous <id>", "Only threads for this pumppuRequestId", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runChatThreads(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("thread [threadId]")
        .description("Get one thread's metadata + participants")
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
        .action(async (threadIdStr, opts) => {
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
            writeJson(await runChatThread(client, id));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("list [threadId]")
        .description("List messages in a thread (does NOT mark read)")
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
        .option("--since <iso>", "Only messages created after this ISO timestamp")
        .option("--limit <n>", "Max messages (default 100, server max 500)", Number)
        .option("--deleted", "Include soft-deleted messages (your own; all for developers)")
        .action(async (threadIdStr, opts) => {
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
            writeJson(await runChatList(client, id, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("search [query]")
        .description("Search your own messages by body text across all your threads (newest first)")
        .option("--search <s>", "Search query (alias for the <query> positional)")
        .option("--limit <n>", "Max results (default 50, server max 200)", Number)
        .action(async (query, opts) => {
        try {
            const client = await getClient();
            writeJson(await runChatSearch(client, resolveSearchQuery(query, opts.search), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const sendCmd = c
        .command("send [threadId]")
        .description("Send a message to a thread. --dry-run previews body + recipients CLIENT-SIDE (no send). --reason → sourceNote (optional).")
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
        .requiredOption("--body <text>", "Message text (max 4000 chars)")
        .option("--source <src>", "Provenance: web|cli|ai (default: IB_SOURCE env or cli)");
    addWriteFlagsToCommand(sendCmd).action(async (threadIdStr, opts) => {
        const body = String(opts.body ?? "").trim();
        if (!body)
            failWith("Message body cannot be empty", 4);
        if (body.length > 4000)
            failWith("Message body too long (max 4000 chars)", 4);
        const source = opts.source ?? process.env.IB_SOURCE ?? "cli";
        if (!["web", "cli", "ai"].includes(source)) {
            failWith(`Invalid --source "${source}" — use web|cli|ai`, 4);
        }
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
            writeJson(await runChatSend(client, id, {
                body,
                source,
                reason: opts.reason,
                idempotencyKey: opts.idempotencyKey,
                dryRun: opts.dryRun,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    c.command("mark-read [threadId]")
        .description("Mark a thread read (stamp lastReadAt)")
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
        .action(async (threadIdStr, opts) => {
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
            writeJson(await runChatMarkRead(client, id));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const deleteCmd = c
        .command("delete <messageId>")
        .description("Soft-delete a chat message. Author may delete own only while unanswered; a developer may moderate. --dry-run previews CLIENT-SIDE (no delete).")
        .option("--thread <id>", "Thread id the message belongs to", Number)
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number);
    addWriteFlagsToCommand(deleteCmd).action(async (messageIdStr, opts) => {
        const messageId = parseOptionalId(messageIdStr, "messageId");
        if (messageId === undefined)
            failWith("messageId is required", 4);
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, {
                thread: opts.thread,
                tarjous: opts.tarjous,
            });
            writeJson(await runChatDelete(client, id, messageId, {
                reason: opts.reason,
                idempotencyKey: opts.idempotencyKey,
                dryRun: opts.dryRun,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const editCmd = c
        .command("edit <messageId>")
        .description("Edit a chat message's body. Author-only and only while unanswered. --dry-run previews the from→to diff CLIENT-SIDE (no edit).")
        .option("--thread <id>", "Thread id the message belongs to", Number)
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
        .requiredOption("--body <text>", "New message text (max 4000 chars)");
    addWriteFlagsToCommand(editCmd).action(async (messageIdStr, opts) => {
        const messageId = parseOptionalId(messageIdStr, "messageId");
        if (messageId === undefined)
            failWith("messageId is required", 4);
        const body = String(opts.body ?? "").trim();
        if (!body)
            failWith("Message body cannot be empty", 4);
        if (body.length > 4000)
            failWith("Message body too long (max 4000 chars)", 4);
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
            writeJson(await runChatEdit(client, id, messageId, {
                body, reason: opts.reason, idempotencyKey: opts.idempotencyKey, dryRun: opts.dryRun,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const restoreCmd = c
        .command("restore <messageId>")
        .description("Restore (un-delete) a soft-deleted chat message. Author or developer. --dry-run previews via the deleted list (no restore).")
        .option("--thread <id>", "Thread id the message belongs to", Number)
        .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number);
    addWriteFlagsToCommand(restoreCmd).action(async (messageIdStr, opts) => {
        const messageId = parseOptionalId(messageIdStr, "messageId");
        if (messageId === undefined)
            failWith("messageId is required", 4);
        try {
            const client = await getClient();
            const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
            writeJson(await runChatRestore(client, id, messageId, {
                reason: opts.reason, idempotencyKey: opts.idempotencyKey, dryRun: opts.dryRun,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map