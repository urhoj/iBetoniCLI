import { qs } from "../../../api/query.js";
import { writeJson } from "../../../output/json.js";
import { guarded, jsonAction } from "../../_shared/action.js";
import { parseId, intFlag, cappedInt } from "../../../targets.js";
/**
 * GET /api/cli/impersonation-sessions — reconstructed sessions as a ListEnvelope.
 * The backend returns `{ items, count, truncated }`.
 */
export async function runImpersonationSessions(client, opts) {
    const res = await client.get(`/api/cli/impersonation-sessions${qs({
        actor: opts.actor,
        target: opts.target,
        endReason: opts.endReason,
        active: opts.active,
        limit: opts.limit,
    })}`);
    return {
        items: res.items ?? [],
        nextCursor: null,
        count: res.count ?? (res.items ?? []).length,
        truncated: res.truncated ?? false,
    };
}
/** GET /api/persons/:personId/impersonation-grants — { outbound, inbound }. */
export async function runImpersonationGrants(client, personId) {
    return client.get(`/api/persons/${personId}/impersonation-grants`);
}
/** Register `ib dev impersonation`. See `src/reference/specs.ts` for the specs. */
export function registerImpersonationCommands(parent, getClient) {
    const imp = parent
        .command("impersonation")
        .description("Impersonation audit trail — reconstructed sessions + grants (developer-only)");
    imp
        .command("sessions")
        .option("--actor <id>", "", intFlag("--actor", 1))
        .option("--target <id>", "", intFlag("--target", 1))
        .option("--end-reason <r>")
        .option("--active")
        .option("--limit <n>", "", cappedInt(1000))
        .action(jsonAction(getClient, runImpersonationSessions));
    imp
        .command("grants <personId>")
        .action(guarded(async (personIdStr) => {
        const personId = parseId(personIdStr, "personId");
        writeJson(await runImpersonationGrants(await getClient(), personId));
    }));
}
//# sourceMappingURL=index.js.map