import { listEnvelope } from "../../api/envelopes.js";
import { failWith, warnNote } from "../../output/json.js";
import { assertEnum, assertPositiveInt, intFlag, parseId } from "../../targets.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
/** GET /api/cli/ai/conversation/:id — developer-only, cross-tenant full transcript. */
export async function runAiConversation(client, id) {
    assertPositiveInt(id, "conversationId");
    return client.get(`/api/cli/ai/conversation/${id}`);
}
/**
 * GET /api/cli/ai/conversations — developer-only, cross-tenant browse list.
 * `truncated` is set client-side against the requested limit (no backend cursor),
 * per the list-envelope contract.
 */
export async function runAiConversationList(client, opts = {}) {
    const limit = opts.limit ?? 20;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        failWith("limit must be an integer between 1 and 100", 4);
    }
    if (opts.personId !== undefined)
        assertPositiveInt(opts.personId, "personId");
    const res = await client.get(`/api/cli/ai/conversations${qs({ limit, personId: opts.personId })}`);
    const items = res.items ?? [];
    return listEnvelope(items, { truncated: items.length >= limit });
}
export const AI_PROVIDERS = ["anthropic", "bedrock", "openai-compat"];
/**
 * POST /api/ai/ask — one real (paid) /ai assistant turn, e.g. a deploy smoke test
 * after a provider swap or SDK bump. A write the model wants comes back as
 * `pendingAction` and is only SURFACED: this command never calls /api/ai/confirm.
 * The backend silently falls back to its default when --provider is not configured
 * on that slot, so a mismatch is flagged instead of passing as a green check.
 * Plain `client.post` on purpose: --read-only refuses it, which also keeps the /ai
 * loop (whose child `ib` runs read-only) from calling itself.
 */
export async function runAiAsk(client, prompt, opts = {}) {
    if (!prompt?.trim())
        failWith("prompt must be a non-empty string", 4);
    assertEnum(opts.provider, AI_PROVIDERS, "--provider");
    const body = {
        prompt,
        conversationId: opts.conversationId,
        keikkaId: opts.keikkaId,
        provider: opts.provider,
    };
    if (opts.dryRun)
        return { dryRun: true, wouldSend: { method: "POST", path: "/api/ai/ask", body } };
    const { msg } = await client.post("/api/ai/ask", body);
    const mismatch = opts.provider !== undefined && msg.provider !== opts.provider;
    if (mismatch) {
        warnNote(`[ib] --provider ${opts.provider} was not used: the backend answered with ${msg.provider} (not configured on this slot?)`);
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
export function registerAiCommands(parent, getClient, opts = {}) {
    const ai = parent
        .command("ai", { hidden: !!opts.hidden })
        .description("Read AI assistant conversations, or send one prompt (developer-only)");
    ai
        .command("conversations")
        .option("--limit <n>", "", (v) => Number(v))
        .option("--person <personId>", "", (v) => Number(v))
        .action(jsonAction(getClient, (client, opts) => runAiConversationList(client, {
        limit: opts.limit,
        personId: opts.person,
    })));
    ai
        .command("conversation <conversationId>")
        .action(jsonAction(getClient, (client, idStr) => runAiConversation(client, parseId(idStr, "conversationId"))));
    ai
        .command("ask <prompt>")
        .option("--provider <name>")
        .option("--conversation <conversationId>", "", intFlag("--conversation"))
        .option("--keikka <keikkaId>", "", intFlag("--keikka"))
        .option("--dry-run")
        .action(jsonAction(getClient, (client, prompt, opts) => runAiAsk(client, prompt, {
        provider: opts.provider,
        conversationId: opts.conversation,
        keikkaId: opts.keikka,
        dryRun: opts.dryRun,
    })));
}
//# sourceMappingURL=index.js.map