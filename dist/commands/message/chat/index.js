import { listEnvelope, toListEnvelope } from "../../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../../api/writeFlags.js";
import { writeJson, failWith } from "../../../output/json.js";
import { addThreadTargetOption, resolveThreadId, targetFrom, threadAction } from "./resolveThread.js";
import { parseId, resolveSearchQuery, queryAliasOption } from "../../../targets.js";
import { jsonAction, guarded } from "../../_shared/action.js";
import { qs } from "../../../api/query.js";
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
    return listEnvelope(items);
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
    return toListEnvelope(await client.get(`/api/messages/threads/${threadId}/messages${qs({
        includeDeleted: opts.deleted ? "1" : undefined,
        since: opts.since || undefined,
        limit: opts.limit,
    })}`));
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
    return toListEnvelope(await client.get(`/api/messages/search?${parts.join("&")}`));
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
 * The dry-run preamble `delete` / `edit` / `restore` share: list the thread and
 * find the target message, exiting 5 when it is absent. All three resolve
 * `--dry-run` client-side (none of the routes honour X-Dry-Run), so each needs
 * the current row before it can describe what WOULD happen.
 *
 * `deleted` switches the listing to soft-deleted rows — `restore`'s target only
 * exists there — and is reflected in the miss message.
 */
async function findMessageForDryRun(client, threadId, messageId, opts = {}) {
    const list = await runChatList(client, threadId, { deleted: opts.deleted });
    const target = list.items.find((m) => Number(m.messageId) === messageId);
    if (!target) {
        failWith(`Message ${messageId} not found ${opts.deleted ? "among deleted " : ""}in thread ${threadId}`, 5);
    }
    return target;
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
        const target = await findMessageForDryRun(client, threadId, messageId);
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
        const target = await findMessageForDryRun(client, threadId, messageId);
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
        await findMessageForDryRun(client, threadId, messageId, { deleted: true });
        return { dryRun: true, threadId, wouldRestore: { messageId } };
    }
    return client.post(`/api/messages/threads/${threadId}/messages/${messageId}/restore`, {}, { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) });
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
        .option("--unread")
        .option("--tarjous <id>", "", Number)
        .action(jsonAction(getClient, (client, opts) => runChatThreads(client, opts)));
    addThreadTargetOption(c.command("thread [threadId]"))
        .action(threadAction(getClient, (client, id) => runChatThread(client, id)));
    addThreadTargetOption(c.command("list [threadId]"))
        .option("--since <iso>")
        .option("--limit <n>", "", Number)
        .option("--deleted")
        .action(threadAction(getClient, (client, id, opts) => runChatList(client, id, opts)));
    c.command("search [query]")
        .option("--search <s>")
        .addOption(queryAliasOption())
        .option("--limit <n>", "", Number)
        .action(jsonAction(getClient, (client, query, opts) => runChatSearch(client, resolveSearchQuery(query, opts.search, opts.query), opts)));
    // Trimmed, non-empty, ≤4000 chars — the message-body contract send and edit share.
    const assertMessageBody = (raw) => {
        const body = String(raw ?? "").trim();
        if (!body)
            failWith("Message body cannot be empty", 4);
        if (body.length > 4000)
            failWith("Message body too long (max 4000 chars)", 4);
        return body;
    };
    // The action tail delete/restore share: parse the messageId, resolve the
    // thread from --thread/--tarjous, writeJson the run result. The id parses
    // BEFORE getClient() so a bad id stays exit 4 even when logged out.
    const messageAction = (run) => guarded(async (messageIdStr, opts) => {
        const messageId = parseId(messageIdStr, "messageId");
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
        writeJson(await run(client, id, messageId, opts));
    });
    const sendCmd = addThreadTargetOption(c.command("send [threadId]"))
        .requiredOption("--body <text>")
        .option("--source <src>");
    addWriteFlagsToCommand(sendCmd).action(guarded(async (threadIdStr, opts) => {
        const body = assertMessageBody(opts.body);
        const source = opts.source ?? process.env.IB_SOURCE ?? "cli";
        if (!["web", "cli", "ai"].includes(source)) {
            failWith(`Invalid --source "${source}" — use web|cli|ai`, 4);
        }
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatSend(client, id, {
            body,
            source,
            reason: opts.reason,
            idempotencyKey: opts.idempotencyKey,
            dryRun: opts.dryRun,
        }));
    }));
    addThreadTargetOption(c.command("mark-read [threadId]"))
        .action(threadAction(getClient, (client, id) => runChatMarkRead(client, id)));
    const deleteCmd = addThreadTargetOption(c.command("delete <messageId>").option("--thread <id>", "", Number));
    addWriteFlagsToCommand(deleteCmd).action(messageAction(runChatDelete));
    const editCmd = addThreadTargetOption(c.command("edit <messageId>").option("--thread <id>", "", Number))
        .requiredOption("--body <text>");
    // Not messageAction: the body guard must stay ahead of getClient(), so a bad
    // body is exit 4 even when logged out.
    addWriteFlagsToCommand(editCmd).action(guarded(async (messageIdStr, opts) => {
        const messageId = parseId(messageIdStr, "messageId");
        const body = assertMessageBody(opts.body);
        const client = await getClient();
        const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
        writeJson(await runChatEdit(client, id, messageId, {
            body, reason: opts.reason, idempotencyKey: opts.idempotencyKey, dryRun: opts.dryRun,
        }));
    }));
    const restoreCmd = addThreadTargetOption(c.command("restore <messageId>").option("--thread <id>", "", Number));
    addWriteFlagsToCommand(restoreCmd).action(messageAction(runChatRestore));
}
//# sourceMappingURL=index.js.map