import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { type WriteFlags, writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { addJsonBodyOptions, resolveJsonBody, type JsonBodyFlags } from "../_shared/jsonBody.js";
import { guarded } from "../_shared/action.js";
import { writeJson } from "../../output/json.js";

export async function runBetomikOrderbookImport(
  client: ApiClient,
  body: Record<string, unknown>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/betomik-orderbook/import", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export function registerBetomikOrderbookCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const group = parent
    .command("betomik-orderbook")
    .description("Betomik order-book import validator staging (developer only)");

  const importCmd = addJsonBodyOptions(group.command("import"));
  addWriteFlagsToCommand(importCmd).action(
    guarded(async (opts: WriteFlags & JsonBodyFlags) => {
      const body = resolveJsonBody(importCmd, opts, { required: true });
      const client = await getClient();
      const result = await runBetomikOrderbookImport(client, body as Record<string, unknown>, opts);
      writeJson(result);
    })
  );
}
