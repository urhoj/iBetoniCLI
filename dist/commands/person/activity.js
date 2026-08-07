import { writeJson } from "../../output/json.js";
import { parseId } from "../../targets.js";
import { guarded } from "../_shared/action.js";
/**
 * GET /api/cli/person/:personId/activity — developer-gated login / security-event /
 * impersonation history for one person. Deploy-gated (no-op until the backend ships).
 */
export async function runPersonActivity(client, personId, opts) {
    const qs = opts.limit !== undefined ? `?limit=${opts.limit}` : "";
    return client.get(`/api/cli/person/${personId}/activity${qs}`);
}
/** Register `ib person activity`. See `src/reference/specs.ts` for the spec. */
export function registerPersonActivityCommand(parent, getClient) {
    parent
        .command("activity <personId>")
        .option("--limit <n>", "", (s) => Number(s))
        .action(guarded(async (personIdStr, opts) => {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runPersonActivity(await getClient(), personId, opts));
    }));
}
//# sourceMappingURL=activity.js.map