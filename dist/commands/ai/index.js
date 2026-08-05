import { failWith, writeJson } from "../../output/json.js";
import { assertPositiveInt, parseId } from "../../targets.js";
import { guarded } from "../_shared/action.js";
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
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts.personId !== undefined) {
        assertPositiveInt(opts.personId, "personId");
        params.set("personId", String(opts.personId));
    }
    const res = await client.get(`/api/cli/ai/conversations?${params.toString()}`);
    const items = res.items ?? [];
    return { items, nextCursor: null, count: items.length, truncated: items.length >= limit };
}
/** Register `ib dev ai conversations` and `ib dev ai conversation <id>`. */
export function registerAiCommands(parent, getClient, opts = {}) {
    const ai = parent
        .command("ai", { hidden: !!opts.hidden })
        .description("Read AI assistant conversations (developer-only)");
    ai
        .command("conversations")
        .option("--limit <n>", "Max rows to return (1-100, default 20)", (v) => Number(v))
        .option("--person <personId>", "Filter to one person's conversations", (v) => Number(v))
        .action(guarded(async (opts) => {
        writeJson(await runAiConversationList(await getClient(), {
            limit: opts.limit,
            personId: opts.person,
        }));
    }));
    ai
        .command("conversation <conversationId>")
        .action(guarded(async (idStr) => {
        writeJson(await runAiConversation(await getClient(), parseId(idStr, "conversationId")));
    }));
}
//# sourceMappingURL=index.js.map