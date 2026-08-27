import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson } from "../../output/json.js";
import { parseId, cappedInt } from "../../targets.js";
import { guarded } from "../_shared/action.js";
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
    .option("--limit <n>", "", cappedInt(1000))
    .action(
      guarded(async (personIdStr: string, opts: PersonActivityOpts) => {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runPersonActivity(await getClient(), personId, opts));
      })
    );
}
