import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { writeJson } from "../../output/json.js";
import { parseId, cappedInt } from "../../targets.js";
import { guarded } from "../_shared/action.js";
import { resolveDate } from "../../dates.js";
export interface PersonActivityOpts {
  limit?: number;
  from?: string;
  to?: string;
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
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.from) params.set("from", resolveDate(opts.from)!);
  if (opts.to) params.set("to", resolveDate(opts.to)!);
  const qs = params.toString();
  return client.get(`/api/cli/person/${personId}/activity${qs ? `?${qs}` : ""}`);
}

/** Register `ib person activity`. See `src/reference/specs.ts` for the spec. */
export function registerPersonActivityCommand(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  parent
    .command("activity <personId>")
    .option("--limit <n>", "", cappedInt(1000))
    .option("--from <date>")
    .option("--to <date>")
    .action(
      guarded(async (personIdStr: string, opts: PersonActivityOpts) => {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runPersonActivity(await getClient(), personId, opts));
      })
    );
}
