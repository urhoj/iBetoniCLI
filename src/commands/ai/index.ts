/**
 * `ib ai` — read AI-assistant conversations, and send one prompt (developer-only).
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
import { failWith, warnNote } from "../../output/json.js";
import { assertEnum, assertPositiveInt, intFlag, parseId } from "../../targets.js";
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

export const AI_PROVIDERS = ["anthropic", "bedrock", "openai-compat"] as const;

/** `{ msg }` payload of POST /api/ai/ask (msgData = raw provider transcript, dropped). */
interface AiAskMsg {
  message: string;
  conversationId: number | null;
  usage?: Record<string, number>;
  provider?: string;
  model?: string;
  pendingAction?: Record<string, unknown>;
}

/**
 * POST /api/ai/ask — one real (paid) /ai assistant turn, e.g. a deploy smoke test
 * after a provider swap or SDK bump. A write the model wants comes back as
 * `pendingAction` and is only SURFACED: this command never calls /api/ai/confirm.
 * The backend silently falls back to its default when --provider is not configured
 * on that slot, so a mismatch is flagged instead of passing as a green check.
 * Plain `client.post` on purpose: --read-only refuses it, which also keeps the /ai
 * loop (whose child `ib` runs read-only) from calling itself.
 */
export async function runAiAsk(
  client: ApiClient,
  prompt: string,
  opts: { provider?: string; conversationId?: number; keikkaId?: number; dryRun?: boolean } = {}
): Promise<Record<string, unknown>> {
  if (!prompt?.trim()) failWith("prompt must be a non-empty string", 4);
  assertEnum(opts.provider, AI_PROVIDERS, "--provider");
  const body = {
    prompt,
    conversationId: opts.conversationId,
    keikkaId: opts.keikkaId,
    provider: opts.provider,
  };
  if (opts.dryRun) return { dryRun: true, wouldSend: { method: "POST", path: "/api/ai/ask", body } };
  const { msg } = await client.post<{ msg: AiAskMsg }>("/api/ai/ask", body);
  const mismatch = opts.provider !== undefined && msg.provider !== opts.provider;
  if (mismatch) {
    warnNote(
      `[ib] --provider ${opts.provider} was not used: the backend answered with ${msg.provider} (not configured on this slot?)`
    );
  }
  return {
    text: msg.message,
    provider: msg.provider,
    ...(mismatch ? { requestedProvider: opts.provider } : {}),
    model: msg.model,
    usage: msg.usage,
    conversationId: msg.conversationId,
    ...(msg.pendingAction ? { pendingAction: msg.pendingAction } : {}),
  };
}

/** Register `ib dev ai conversations`, `ib dev ai conversation <id>` and `ib dev ai ask <prompt>`. */
export function registerAiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const ai = parent
    .command("ai", { hidden: !!opts.hidden })
    .description("Read AI assistant conversations, or send one prompt (developer-only)");

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

  ai
    .command("ask <prompt>")
    .option("--provider <name>")
    .option("--conversation <conversationId>", "", intFlag("--conversation"))
    .option("--keikka <keikkaId>", "", intFlag("--keikka"))
    .option("--dry-run")
    .action(
      jsonAction(
        getClient,
        (
          client,
          prompt: string,
          opts: { provider?: string; conversation?: number; keikka?: number; dryRun?: boolean }
        ) =>
          runAiAsk(client, prompt, {
            provider: opts.provider,
            conversationId: opts.conversation,
            keikkaId: opts.keikka,
            dryRun: opts.dryRun,
          })
      )
    );
}
