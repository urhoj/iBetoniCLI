/**
 * `ib ai` — read AI-assistant conversations (developer-only).
 *
 * `ib ai conversations` lists recent conversations (compact rows, for audit/browse);
 * `ib ai conversation <id>` fetches the FULL transcript of one. Both go over
 * /api/cli/ai/* (dev-gated, cross-tenant). The id for the transcript read can come
 * from a feedback row's context.conversationId (`ib feedback create` stamps it when
 * the AI files feedback from the /ai page) OR from the `conversations` list.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";

/** One row of the `ib ai conversations` browse list (no message bodies). */
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
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError("conversationId must be a positive integer", 400, null, 4);
  }
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
    throw new CliError("limit must be an integer between 1 and 100", 400, null, 4);
  }
  const params = new URLSearchParams({ limit: String(limit) });
  if (opts.personId !== undefined) {
    if (!Number.isInteger(opts.personId) || opts.personId <= 0) {
      throw new CliError("personId must be a positive integer", 400, null, 4);
    }
    params.set("personId", String(opts.personId));
  }
  const res = await client.get<{ items?: AiConversationRow[] }>(
    `/api/cli/ai/conversations?${params.toString()}`
  );
  const items = res.items ?? [];
  return { items, nextCursor: null, count: items.length, truncated: items.length >= limit };
}

/** Register `ib ai conversations` and `ib ai conversation <id>`. */
export function registerAiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const ai = parent
    .command("ai")
    .description("Read AI assistant conversations (developer-only)");

  ai
    .command("conversations")
    .description(
      "List recent /ai conversations (developer-only, cross-tenant) for audit; drill into one with `ib ai conversation <id>`"
    )
    .option("--limit <n>", "Max rows to return (1-100, default 20)", (v) => Number(v))
    .option("--person <personId>", "Filter to one person's conversations", (v) => Number(v))
    .action(async (opts: { limit?: number; person?: number }) => {
      try {
        writeJson(
          await runAiConversationList(await getClient(), {
            limit: opts.limit,
            personId: opts.person,
          })
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  ai
    .command("conversation <conversationId>")
    .description(
      "Fetch the full transcript of an /ai conversation by id (developer-only, cross-tenant)"
    )
    .action(async (idStr: string) => {
      try {
        writeJson(await runAiConversation(await getClient(), Number(idStr)));
      } catch (e) {
        exitWithError(e);
      }
    });
}
