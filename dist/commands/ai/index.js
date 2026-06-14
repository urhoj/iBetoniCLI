import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
/** GET /api/cli/ai/conversation/:id — developer-only, cross-tenant full transcript. */
export async function runAiConversation(client, id) {
    if (!Number.isInteger(id) || id <= 0) {
        throw new CliError("conversationId must be a positive integer", 400, null, 4);
    }
    return client.get(`/api/cli/ai/conversation/${id}`);
}
/** Register `ib ai conversation <id>`. */
export function registerAiCommands(parent, getClient) {
    const ai = parent
        .command("ai")
        .description("Read AI assistant conversations (developer-only)");
    ai
        .command("conversation <conversationId>")
        .description("Fetch the full transcript of an /ai conversation by id (developer-only, cross-tenant)")
        .action(async (idStr) => {
        try {
            writeJson(await runAiConversation(await getClient(), Number(idStr)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map