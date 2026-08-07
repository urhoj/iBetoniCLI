import { jsonAction } from "../_shared/action.js";
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
        .option("--details")
        .action(jsonAction(getClient, (client, opts) => runInbox(client, { details: opts.details })));
}
//# sourceMappingURL=index.js.map