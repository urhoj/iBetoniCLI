import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import { listEnvelope, toListEnvelope, type ListEnvelope } from "../../../api/envelopes.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../../api/writeFlags.js";
import { writeJson, failWith } from "../../../output/json.js";
import { addThreadTargetOption, resolveThreadId, targetFrom } from "./resolveThread.js";
import { parseId, resolveSearchQuery } from "../../../targets.js";
import { jsonAction, guarded } from "../../_shared/action.js";
import { qs } from "../../../api/query.js";

type Row = Record<string, unknown>;

/**
 * GET /api/messages/threads/mine → your threads (inbox), newest first.
 * `--tarjous` filters to one pumppuRequest; `--unread` to unreadCount > 0.
 * Both filters are client-side (the route returns the full participant set).
 */
export async function runChatThreads(
  client: ApiClient,
  opts: { unread?: boolean; tarjous?: number }
): Promise<ListEnvelope<Row>> {
  const rows = await client.get<Row[]>("/api/messages/threads/mine");
  let items = Array.isArray(rows) ? rows : [];
  if (opts.tarjous !== undefined) {
    items = items.filter(
      (r) => r.contextType === "pumppuRequest" && Number(r.contextId) === opts.tarjous
    );
  }
  if (opts.unread) items = items.filter((r) => Number(r.unreadCount) > 0);
  return listEnvelope(items);
}

/** GET /api/messages/threads/:id → thread metadata + participants. */
export async function runChatThread(client: ApiClient, threadId: number): Promise<Row> {
  return client.get<Row>(`/api/messages/threads/${threadId}`);
}

/**
 * GET /api/messages/threads/:id/messages → messages, oldest first. Does NOT
 * mark the thread read. `--since` backfills (ISO); `--limit` caps (server max 500).
 * `--deleted` adds `?includeDeleted=1` (own deleted rows; all rows for developers).
 */
export async function runChatList(
  client: ApiClient,
  threadId: number,
  opts: { since?: string; limit?: number; deleted?: boolean }
): Promise<ListEnvelope<Row>> {
  return toListEnvelope<Row>(
    await client.get<Row[]>(
      `/api/messages/threads/${threadId}/messages${qs({
        includeDeleted: opts.deleted ? "1" : undefined,
        since: opts.since || undefined,
        limit: opts.limit,
      })}`
    )
  );
}

/**
 * GET /api/messages/search?q=&limit= — search the caller's own messages by body
 * text across all their threads, newest first. Read-only. Uses manual
 * encodeURIComponent (the backend qs parser does not decode "+" to a space).
 */
export async function runChatSearch(
  client: ApiClient,
  query: string,
  opts: { limit?: number }
): Promise<ListEnvelope<Row>> {
  const parts = [`q=${encodeURIComponent(query)}`];
  if (opts.limit !== undefined) parts.push(`limit=${opts.limit}`);
  return toListEnvelope<Row>(await client.get<Row[]>(`/api/messages/search?${parts.join("&")}`));
}

/** Options for {@link runChatSend}. `source` is already resolved by the action. */
export interface ChatSendOpts extends WriteFlags {
  body: string;
  source: string;
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
export async function runChatSend(
  client: ApiClient,
  threadId: number,
  opts: ChatSendOpts
): Promise<unknown> {
  if (opts.dryRun) {
    const meta = await client.get<{ participants?: Row[] }>(
      `/api/messages/threads/${threadId}`
    );
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
  const payload: Row = { body: opts.body, source: opts.source };
  if (opts.reason) payload.sourceNote = opts.reason;
  return client.post<unknown>(`/api/messages/threads/${threadId}/messages`, payload, {
    headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }),
  });
}

/** POST /api/messages/threads/:id/read — stamp the caller's lastReadAt to now. */
export async function runChatMarkRead(
  client: ApiClient,
  threadId: number
): Promise<unknown> {
  return client.post<unknown>(`/api/messages/threads/${threadId}/read`, {});
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
async function findMessageForDryRun(
  client: ApiClient,
  threadId: number,
  messageId: number,
  opts: { deleted?: boolean } = {}
): Promise<Row> {
  const list = await runChatList(client, threadId, { deleted: opts.deleted });
  const target = list.items.find((m) => Number(m.messageId) === messageId);
  if (!target) {
    failWith(
      `Message ${messageId} not found ${opts.deleted ? "among deleted " : ""}in thread ${threadId}`,
      5
    );
  }
  return target;
}

/** Options for {@link runChatDelete} — the universal write flags, nothing extra. */
export type ChatDeleteOpts = WriteFlags;

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
export async function runChatDelete(
  client: ApiClient,
  threadId: number,
  messageId: number,
  opts: ChatDeleteOpts
): Promise<unknown> {
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
  return client.delete<unknown>(
    `/api/messages/threads/${threadId}/messages/${messageId}`,
    { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) }
  );
}

/** Options for {@link runChatEdit}. */
export interface ChatEditOpts extends WriteFlags {
  body: string;
}

/**
 * PATCH /api/messages/threads/:id/messages/:messageId — edit a message body.
 *
 * `--dry-run` is CLIENT-SIDE: lists the thread, finds the target, returns the
 * from→to diff without issuing the PATCH (works under --read-only). A miss →
 * exit 5. Server-side this is author-only and only while unanswered.
 */
export async function runChatEdit(
  client: ApiClient,
  threadId: number,
  messageId: number,
  opts: ChatEditOpts
): Promise<unknown> {
  if (opts.dryRun) {
    const target = await findMessageForDryRun(client, threadId, messageId);
    return {
      dryRun: true,
      threadId,
      wouldEdit: { messageId, from: target.body ?? null, to: opts.body },
    };
  }
  return client.patch<unknown>(
    `/api/messages/threads/${threadId}/messages/${messageId}`,
    { body: opts.body },
    { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) }
  );
}

/** Options for {@link runChatRestore} — the universal write flags, nothing extra. */
export type ChatRestoreOpts = WriteFlags;

/**
 * POST /api/messages/threads/:id/messages/:messageId/restore — un-soft-delete.
 *
 * `--dry-run` is CLIENT-SIDE: lists deleted messages (?includeDeleted=1), finds
 * the target, returns wouldRestore without POSTing (works under --read-only). A
 * miss → exit 5. Server-side: author or sysadmin/developer.
 */
export async function runChatRestore(
  client: ApiClient,
  threadId: number,
  messageId: number,
  opts: ChatRestoreOpts
): Promise<unknown> {
  if (opts.dryRun) {
    await findMessageForDryRun(client, threadId, messageId, { deleted: true });
    return { dryRun: true, threadId, wouldRestore: { messageId } };
  }
  return client.post<unknown>(
    `/api/messages/threads/${threadId}/messages/${messageId}/restore`,
    {},
    { headers: writeFlagsToHeaders({ idempotencyKey: opts.idempotencyKey, reason: opts.reason }) }
  );
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
export function registerMessageChatCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const c = parent
    .command("chat")
    .description("Conversational message threads (Jerry tarjous now, keikka later)");

  c.command("threads")
    .option("--unread", "Only threads with unread messages")
    .option("--tarjous <id>", "Only threads for this pumppuRequestId", Number)
    .action(
      jsonAction(getClient, (client, opts: { unread?: boolean; tarjous?: number }) =>
        runChatThreads(client, opts)
      )
    );

  addThreadTargetOption(c.command("thread [threadId]"))
    .action(
      guarded(async (threadIdStr: string | undefined, opts: { tarjous?: number }) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatThread(client, id));
      })
    );

  addThreadTargetOption(c.command("list [threadId]"))
    .option("--since <iso>", "Only messages created after this ISO timestamp")
    .option("--limit <n>", "Max messages (default 100, server max 500)", Number)
    .option("--deleted", "Include soft-deleted messages (your own; all for developers)")
    .action(
      guarded(async (
        threadIdStr: string | undefined,
        opts: { tarjous?: number; since?: string; limit?: number; deleted?: boolean }
      ) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatList(client, id, opts));
      })
    );

  c.command("search [query]")
    .option("--search <s>", "Search query (alias for the <query> positional)")
    .option("--limit <n>", "Max results (default 50, server max 200)", Number)
    .action(
      jsonAction(getClient, (client, query: string | undefined, opts: { search?: string; limit?: number }) =>
        runChatSearch(client, resolveSearchQuery(query, opts.search), opts)
      )
    );

  const sendCmd = addThreadTargetOption(c.command("send [threadId]"))
    .requiredOption("--body <text>", "Message text (max 4000 chars)")
    .option("--source <src>", "Provenance: web|cli|ai (default: IB_SOURCE env or cli)");
  addWriteFlagsToCommand(sendCmd).action(
    guarded(async (
      threadIdStr: string | undefined,
      opts: WriteFlags & {
        tarjous?: number;
        body: string;
        source?: string;
      }
    ) => {
      const body = String(opts.body ?? "").trim();
      if (!body) failWith("Message body cannot be empty", 4);
      if (body.length > 4000) failWith("Message body too long (max 4000 chars)", 4);
      const source = opts.source ?? process.env.IB_SOURCE ?? "cli";
      if (!["web", "cli", "ai"].includes(source)) {
        failWith(`Invalid --source "${source}" — use web|cli|ai`, 4);
      }
      const client = await getClient();
      const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
      writeJson(
        await runChatSend(client, id, {
          body,
          source,
          reason: opts.reason,
          idempotencyKey: opts.idempotencyKey,
          dryRun: opts.dryRun,
        })
      );
    })
  );

  addThreadTargetOption(c.command("mark-read [threadId]"))
    .action(
      guarded(async (threadIdStr: string | undefined, opts: { tarjous?: number }) => {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatMarkRead(client, id));
      })
    );

  const deleteCmd = addThreadTargetOption(
    c.command("delete <messageId>").option("--thread <id>", "Thread id the message belongs to", Number)
  );
  addWriteFlagsToCommand(deleteCmd).action(
    guarded(async (
      messageIdStr: string,
      opts: WriteFlags & { thread?: number; tarjous?: number }
    ) => {
      const messageId = parseId(messageIdStr, "messageId");
      const client = await getClient();
      const id = await resolveThreadId(client, {
        thread: opts.thread,
        tarjous: opts.tarjous,
      });
      writeJson(await runChatDelete(client, id, messageId, opts));
    })
  );

  const editCmd = addThreadTargetOption(
    c.command("edit <messageId>").option("--thread <id>", "Thread id the message belongs to", Number)
  )
    .requiredOption("--body <text>", "New message text (max 4000 chars)");
  addWriteFlagsToCommand(editCmd).action(
    guarded(async (
      messageIdStr: string,
      opts: WriteFlags & { thread?: number; tarjous?: number; body: string }
    ) => {
      const messageId = parseId(messageIdStr, "messageId");
      const body = String(opts.body ?? "").trim();
      if (!body) failWith("Message body cannot be empty", 4);
      if (body.length > 4000) failWith("Message body too long (max 4000 chars)", 4);
      const client = await getClient();
      const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
      writeJson(await runChatEdit(client, id, messageId, {
        body, reason: opts.reason, idempotencyKey: opts.idempotencyKey, dryRun: opts.dryRun,
      }));
    })
  );

  const restoreCmd = addThreadTargetOption(
    c.command("restore <messageId>").option("--thread <id>", "Thread id the message belongs to", Number)
  );
  addWriteFlagsToCommand(restoreCmd).action(
    guarded(async (
      messageIdStr: string,
      opts: WriteFlags & { thread?: number; tarjous?: number }
    ) => {
      const messageId = parseId(messageIdStr, "messageId");
      const client = await getClient();
      const id = await resolveThreadId(client, { thread: opts.thread, tarjous: opts.tarjous });
      writeJson(await runChatRestore(client, id, messageId, opts));
    })
  );
}
