/**
 * `ib ai` — read AI-assistant conversations (developer-only).
 *
 * `ib ai conversation <id>` fetches the FULL transcript of an /ai conversation
 * over GET /api/cli/ai/conversation/:id (dev-gated, cross-tenant). The id comes
 * from a feedback row's context.conversationId — `ib feedback create` stamps it
 * automatically when the AI files feedback from the /ai page.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";

/** GET /api/cli/ai/conversation/:id — developer-only, cross-tenant full transcript. */
export async function runAiConversation(client: ApiClient, id: number): Promise<unknown> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError("conversationId must be a positive integer", 400, null, 4);
  }
  return client.get<unknown>(`/api/cli/ai/conversation/${id}`);
}

/** Register `ib ai conversation <id>`. */
export function registerAiCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const ai = parent
    .command("ai")
    .description("Read AI assistant conversations (developer-only)");

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
