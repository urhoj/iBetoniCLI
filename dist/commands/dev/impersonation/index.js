import { writeJson, exitWithError } from "../../../output/json.js";
import { parseId } from "../../../targets.js";
/** Build a `?k=v&...` suffix from the defined filters. */
function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined)
            u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : "";
}
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
        .description("Reconstructed impersonation sessions (personLog 30/31/32) with endReason")
        .option("--actor <id>", "Filter to sessions run BY this actor personId", (s) => Number(s))
        .option("--target <id>", "Filter to sessions run AS this target personId", (s) => Number(s))
        .option("--end-reason <r>", "Filter by endReason (manual|timeout|error|logout)")
        .option("--active", "Only still-open sessions (no end row)")
        .option("--limit <n>", "Max sessions (default 100, max 1000)", (s) => Number(s))
        .action(async (opts) => {
        try {
            writeJson(await runImpersonationSessions(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    imp
        .command("grants <personId>")
        .description("Who may impersonate whom for one person (outbound/inbound grants)")
        .action(async (personIdStr) => {
        try {
            const personId = parseId(personIdStr, "personId");
            writeJson(await runImpersonationGrants(await getClient(), personId));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map