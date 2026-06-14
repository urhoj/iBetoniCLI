import type { Command } from "commander";
import type { ApiClient } from "../../../api/client.js";
import type { ListEnvelope } from "../../../api/envelopes.js";
import { addWriteFlagsToCommand } from "../../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../../output/json.js";
import { resolveThreadId, type ThreadTarget } from "./resolveThread.js";

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
  return client.post<unknown>(`/api/messages/threads/${threadId}/messages`, payload);
}

/** POST /api/messages/threads/:id/read — stamp the caller's lastReadAt to now. */
export async function runChatMarkRead(
  client: ApiClient,
  threadId: number
): Promise<unknown> {
  return client.post<unknown>(`/api/messages/threads/${threadId}/read`, {});
}
