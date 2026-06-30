import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { parseId } from "../../targets.js";
/** GET /api/cli/ai/conversation/:id — developer-only, cross-tenant full transcript. */
export async function runAiConversation(client, id) {
    if (!Number.isInteger(id) || id <= 0) {
        throw new CliError("conversationId must be a positive integer", 400, null, 4);
    }
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
        throw new CliError("limit must be an integer between 1 and 100", 400, null, 4);
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (opts.personId !== undefined) {
        if (!Number.isInteger(opts.personId) || opts.personId <= 0) {
            throw new CliError("personId must be a positive integer", 400, null, 4);
        }
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
        .description("List recent /ai conversations (developer-only, cross-tenant) for audit; drill into one with `ib dev ai conversation <id>`")
        .option("--limit <n>", "Max rows to return (1-100, default 20)", (v) => Number(v))
        .option("--person <personId>", "Filter to one person's conversations", (v) => Number(v))
        .action(async (opts) => {
        try {
            writeJson(await runAiConversationList(await getClient(), {
                limit: opts.limit,
                personId: opts.person,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    ai
        .command("conversation <conversationId>")
        .description("Fetch the full transcript of an /ai conversation by id (developer-only, cross-tenant)")
        .action(async (idStr) => {
        try {
            writeJson(await runAiConversation(await getClient(), parseId(idStr, "conversationId")));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map