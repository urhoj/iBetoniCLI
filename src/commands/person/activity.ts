import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { parseId } from "../../targets.js";

export interface PersonActivityOpts {
  limit?: number;
}

/**
 * GET /api/cli/person/:personId/activity — developer-gated login / security-event /
 * impersonation history for one person. Deploy-gated (no-op until the backend ships).
 */
export async function runPersonActivity(
  client: ApiClient,
  personId: number,
  opts: PersonActivityOpts
): Promise<unknown> {
  const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : "";
  return client.get(`/api/cli/person/${personId}/activity${qs}`);
}

/** Register `ib person activity`. See `src/reference/specs.ts` for the spec. */
export function registerPersonActivityCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("activity <personId>")
    .description(
      "Login / security-event / impersonation history for one person (developer-only)"
    )
    .option("--limit <n>", "Max rows per list (default 100, max 1000)", (s: string) => Number(s))
    .action(async (personIdStr: string, opts: PersonActivityOpts) => {
      try {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runPersonActivity(await getClient(), personId, opts));
      } catch (e) {
        exitWithError(e);
      }
    });
}
