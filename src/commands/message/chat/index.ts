import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import type { ListEnvelope } from "../../../api/envelopes.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders } from "../../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../../output/json.js";
import { resolveThreadId, type ThreadTarget } from "./resolveThread.js";
import { parseOptionalId } from "../../../targets.js";

type Row = Record<string, unknown>;

/** Wrap a backend array into the universal `{ items, nextCursor, count }` envelope. */
function toEnvelope(value: unknown): ListEnvelope<Row> {
  const items = Array.isArray(value) ? (value as Row[]) : [];
  return { items, nextCursor: null, count: items.length };
}

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
  return { items, nextCursor: null, count: items.length };
}

/** GET /api/messages/threads/:id → thread metadata + participants. */
export async function runChatThread(client: ApiClient, threadId: number): Promise<Row> {
  return client.get<Row>(`/api/messages/threads/${threadId}`);
}

/**
 * GET /api/messages/threads/:id/messages → messages, oldest first. Does NOT
 * mark the thread read. `--since` backfills (ISO); `--limit` caps (server max 500).
 */
export async function runChatList(
  client: ApiClient,
  threadId: number,
  opts: { since?: string; limit?: number }
): Promise<ListEnvelope<Row>> {
  const params = new URLSearchParams();
  if (opts.since) params.set("since", opts.since);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return toEnvelope(
    await client.get<Row[]>(
      `/api/messages/threads/${threadId}/messages${qs ? `?${qs}` : ""}`
    )
  );
}

/** Options for {@link runChatSend}. `source` is already resolved by the action. */
export interface ChatSendOpts {
  body: string;
  source: string;
  reason?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
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

/** Options for {@link runChatDelete}. */
export interface ChatDeleteOpts {
  reason?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
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
export async function runChatDelete(
  client: ApiClient,
  threadId: number,
  messageId: number,
  opts: ChatDeleteOpts
): Promise<unknown> {
  if (opts.dryRun) {
    const list = await runChatList(client, threadId, {});
    const target = list.items.find((m) => Number(m.messageId) === messageId);
    if (!target) failWith(`Message ${messageId} not found in thread ${threadId}`, 5);
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

/** Resolve the {@link ThreadTarget} from a positional + --tarjous option. */
function targetFrom(threadIdStr: string | undefined, opts: { tarjous?: number }): ThreadTarget {
  return {
    thread: parseOptionalId(threadIdStr, "threadId"),
    tarjous: opts.tarjous,
  };
}

/**
 * Register `ib message chat` — conversational threads over /api/messages/*:
 *   threads              inbox (your threads, unread + last-message preview)
 *   thread [id]          one thread's meta + participants
 *   list [id]            messages in a thread (does NOT mark read)
 *   send [id] --body     send a message (client-side --dry-run; --reason→sourceNote)
 *   mark-read [id]       stamp lastReadAt
 *   delete <messageId>   soft-delete a message (author-if-unanswered / dev moderation)
 *
 * Every thread-targeting leaf accepts a raw threadId OR --tarjous <pumppuRequestId>.
 * send/mark-read/delete are writes (blocked under --read-only by the client write-lock).
 */
export function registerMessageChatCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const c = parent
    .command("chat")
    .description("Conversational message threads (Jerry tarjous now, keikka later)");

  c.command("threads")
    .description("List your message threads (inbox), newest first")
    .option("--unread", "Only threads with unread messages")
    .option("--tarjous <id>", "Only threads for this pumppuRequestId", Number)
    .action(async (opts: { unread?: boolean; tarjous?: number }) => {
      try {
        const client = await getClient();
        writeJson(await runChatThreads(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("thread [threadId]")
    .description("Get one thread's metadata + participants")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .action(async (threadIdStr: string | undefined, opts: { tarjous?: number }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatThread(client, id));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("list [threadId]")
    .description("List messages in a thread (does NOT mark read)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .option("--since <iso>", "Only messages created after this ISO timestamp")
    .option("--limit <n>", "Max messages (default 100, server max 500)", Number)
    .action(
      async (
        threadIdStr: string | undefined,
        opts: { tarjous?: number; since?: string; limit?: number }
      ) => {
        try {
          const client = await getClient();
          const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
          writeJson(await runChatList(client, id, opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  const sendCmd = c
    .command("send [threadId]")
    .description(
      "Send a message to a thread. --dry-run previews body + recipients CLIENT-SIDE (no send). --reason → sourceNote (optional)."
    )
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .requiredOption("--body <text>", "Message text (max 4000 chars)")
    .option("--source <src>", "Provenance: web|cli|ai (default: IB_SOURCE env or cli)");
  addWriteFlagsToCommand(sendCmd).action(
    async (
      threadIdStr: string | undefined,
      opts: {
        tarjous?: number;
        body: string;
        source?: string;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      const body = String(opts.body ?? "").trim();
      if (!body) failWith("Message body cannot be empty", 4);
      if (body.length > 4000) failWith("Message body too long (max 4000 chars)", 4);
      const source = opts.source ?? process.env.IB_SOURCE ?? "cli";
      if (!["web", "cli", "ai"].includes(source)) {
        failWith(`Invalid --source "${source}" — use web|cli|ai`, 4);
      }
      try {
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
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  c.command("mark-read [threadId]")
    .description("Mark a thread read (stamp lastReadAt)")
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number)
    .action(async (threadIdStr: string | undefined, opts: { tarjous?: number }) => {
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, targetFrom(threadIdStr, opts));
        writeJson(await runChatMarkRead(client, id));
      } catch (e) {
        exitWithError(e);
      }
    });

  const deleteCmd = c
    .command("delete <messageId>")
    .description(
      "Soft-delete a chat message. Author may delete own only while unanswered; a developer may moderate. --dry-run previews CLIENT-SIDE (no delete)."
    )
    .option("--thread <id>", "Thread id the message belongs to", Number)
    .option("--tarjous <id>", "Resolve the thread from this pumppuRequestId", Number);
  addWriteFlagsToCommand(deleteCmd).action(
    async (
      messageIdStr: string,
      opts: {
        thread?: number;
        tarjous?: number;
        dryRun?: boolean;
        idempotencyKey?: string;
        reason?: string;
      }
    ) => {
      const messageId = parseOptionalId(messageIdStr, "messageId");
      if (messageId === undefined) failWith("messageId is required", 4);
      try {
        const client = await getClient();
        const id = await resolveThreadId(client, {
          thread: opts.thread,
          tarjous: opts.tarjous,
        });
        writeJson(
          await runChatDelete(client, id, messageId, {
            reason: opts.reason,
            idempotencyKey: opts.idempotencyKey,
            dryRun: opts.dryRun,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    }
  );
}
