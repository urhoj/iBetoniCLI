import { writeJson } from "../../output/json.js";
import { cappedInt, intFlag, resolvePersonTarget } from "../../targets.js";
import { guarded } from "../_shared/action.js";
import { resolveDate } from "../../dates.js";
/**
 * GET /api/cli/person/:personId/activity — developer-gated login / security-event /
 * impersonation history for one person. Deploy-gated (no-op until the backend ships).
 */
export async function runPersonActivity(client, personId, opts) {
    const params = new URLSearchParams();
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    if (opts.from)
        params.set("from", resolveDate(opts.from));
    if (opts.to)
        params.set("to", resolveDate(opts.to));
    const qs = params.toString();
    return client.get(`/api/cli/person/${personId}/activity${qs ? `?${qs}` : ""}`);
}
/** Register `ib person activity`. See `src/reference/specs.ts` for the spec. */
export function registerPersonActivityCommand(parent, getClient) {
    parent
        .command("activity [personId]")
        .option("--person <id>", "", intFlag("--person"))
        .option("--limit <n>", "", cappedInt(1000))
        .option("--from <date>")
        .option("--to <date>")
        .action(guarded(async (personIdStr, opts) => {
        const personId = resolvePersonTarget(personIdStr, opts.person);
        writeJson(await runPersonActivity(await getClient(), personId, opts));
    }));
}
//# sourceMappingURL=activity.js.map