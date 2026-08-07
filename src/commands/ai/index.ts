/**
 * `ib ai` — read AI-assistant conversations (developer-only).
 *
 * `ib dev ai conversations` lists recent conversations (compact rows, for audit/browse);
 * `ib dev ai conversation <id>` fetches the FULL transcript of one. Both go over
 * /api/cli/ai/* (dev-gated, cross-tenant). The id for the transcript read can come
 * from a feedback row's context.conversationId (`ib dev feedback create` stamps it when
 * the AI files feedback from the /ai page) OR from the `conversations` list.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { failWith } from "../../output/json.js";
import { assertPositiveInt, parseId } from "../../targets.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
/** One row of the `ib dev ai conversations` browse list (no message bodies). */
export interface AiConversationRow {
  conversationId: number;
  personId: number;
  ownerAsiakasId: number;
  entryTime: string;
  messageCount: number;
}

/** GET /api/cli/ai/conversation/:id — developer-only, cross-tenant full transcript. */
export async function runAiConversation(
  client: ApiClient,
  id: number
): Promise<Record<string, unknown>> {
  assertPositiveInt(id, "conversationId");
  return client.get<Record<string, unknown>>(`/api/cli/ai/conversation/${id}`);
}

/**
 * GET /api/cli/ai/conversations — developer-only, cross-tenant browse list.
 * `truncated` is set client-side against the requested limit (no backend cursor),
 * per the list-envelope contract.
 */
export async function runAiConversationList(
  client: ApiClient,
  opts: { limit?: number; personId?: number } = {}
): Promise<ListEnvelope<AiConversationRow>> {
  const limit = opts.limit ?? 20;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    failWith("limit must be an integer between 1 and 100", 4);
  }
  if (opts.personId !== undefined) assertPositiveInt(opts.personId, "personId");
  const res = await client.get<{ items?: AiConversationRow[] }>(
    `/api/cli/ai/conversations${qs({ limit, personId: opts.personId })}`
  );
  const items = res.items ?? [];
  return listEnvelope(items, { truncated: items.length >= limit });
}

/** Register `ib dev ai conversations` and `ib dev ai conversation <id>`. */
export function registerAiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const ai = parent
    .command("ai", { hidden: !!opts.hidden })
    .description("Read AI assistant conversations (developer-only)");

  ai
    .command("conversations")
    .option("--limit <n>", "", (v) => Number(v))
    .option("--person <personId>", "", (v) => Number(v))
    .action(
      jsonAction(getClient, (client, opts: { limit?: number; person?: number }) =>
        runAiConversationList(client, {
          limit: opts.limit,
          personId: opts.person,
        })
      )
    );

  ai
    .command("conversation <conversationId>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runAiConversation(client, parseId(idStr, "conversationId"))
      )
    );
}
