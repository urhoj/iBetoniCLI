import { writeJson, exitWithError } from "../../output/json.js";
/**
 * `ib inbox` — one aggregated rollup of the six open/incomplete operator signals
 * (deploy-pending changelog, unresolved feedback, open support
 * escalations, staged legal drafts, glossary misses, live no_supply
 * tarjouspyynnot). The single source of truth
 * behind the daily morning-report routine and the /admin operator dashboard.
 * Read-only; developer-gated server-side.
 */
export async function runInbox(client, opts = {}) {
    const qs = opts.details ? "?details=1" : "";
    return client.get(`/api/cli/inbox${qs}`);
}
export function registerInboxCommand(parent, getClient, opts = {}) {
    parent
        .command("inbox", { hidden: !!opts.hidden })
        .description("Aggregated operator inbox: counts of every open/incomplete signal (deploy-pending changelog, unresolved feedback, open support, staged legal drafts, glossary misses, live no_supply tarjouspyynnot) plus a `needsYou` headline")
        .option("--details", "Include slimmed top-items per signal, not just counts")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runInbox(client, { details: opts.details }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map