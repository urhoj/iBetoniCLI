import type { ApiClient } from "../../../api/client.js";
import { CliError } from "../../../api/errors.js";

/** How a command targets a thread: a raw id, or a pumppuRequest to resolve. */
export interface ThreadTarget {
  /** Raw threadId (positional). Wins when present. */
  thread?: number;
  /** A pumppuRequestId — resolved to its thread via GET /threads/mine. */
  tarjous?: number;
}

/** Minimal shape of a /threads/mine row used for resolution. */
interface MineRow {
  threadId: number;
  contextType: string;
  contextId: number;
  ownerAsiakasId: number;
}

/**
 * Resolve a {@link ThreadTarget} to a concrete threadId.
 *
 * - raw `thread` → returned as-is (no network call).
 * - `tarjous` → filter GET /api/messages/threads/mine by
 *   contextType 'pumppuRequest' + contextId; exactly one match wins.
 *   Zero → exit 5 (not-found); multiple (one-thread-per-provider) → exit 4
 *   listing the candidate threadIds so the caller can pass one explicitly.
 * - neither → exit 4.
 *
 * Context-blind beyond the 'pumppuRequest' filter: when keikka messaging ships,
 * add a `--keikka` branch here and nothing else in the chat group changes.
 */
export async function resolveThreadId(
  client: ApiClient,
  target: ThreadTarget
): Promise<number> {
  if (target.thread !== undefined && Number.isFinite(target.thread)) {
    return target.thread;
  }
  if (target.tarjous === undefined) {
    throw new CliError(
      "Provide a threadId or --tarjous <pumppuRequestId>",
      0,
      null,
      4
    );
  }
  const rows = await client.get<MineRow[]>("/api/messages/threads/mine");
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (r) => r.contextType === "pumppuRequest" && Number(r.contextId) === target.tarjous
  );
  if (matches.length === 1) return Number(matches[0].threadId);
  if (matches.length === 0) {
    throw new CliError(
      `No thread for tarjous ${target.tarjous} — a thread is created when a provider drafts an offer.`,
      0,
      null,
      5
    );
  }
  const candidates = matches
    .map((m) => `threadId ${m.threadId} (provider asiakasId ${m.ownerAsiakasId})`)
    .join(", ");
  throw new CliError(
    `Multiple threads for tarjous ${target.tarjous}: ${candidates}. Pass a threadId explicitly.`,
    0,
    null,
    4
  );
}
