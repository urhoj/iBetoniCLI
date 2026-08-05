import { listEnvelope } from "../../api/envelopes.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
/** GET open purchase invoices (payables) → ListEnvelope + summary. */
export async function runFennoaPurchases(client, opts) {
    const res = await client.get(`/api/admin/fennoa/purchase-invoices${qs({
        open: opts.all ? 0 : undefined,
        months: opts.months,
        asiakas: opts.asiakas,
        refresh: opts.refresh ? 1 : undefined,
    })}`);
    const items = res.invoices ?? [];
    return {
        ...listEnvelope(items),
        summary: res.summary,
        fetchedAt: res.fetchedAt,
        asiakasId: res.asiakasId,
        months: res.months,
        ...(res.cached ? { cached: true } : {}),
    };
}
export function registerFennoaCommands(parent, getClient) {
    const fennoa = parent.command("fennoa").description("Fennoa accounting integration — PumiNet Oy purchase invoices (system admin).");
    fennoa
        .command("purchases")
        .option("--all", "Include settled invoices in the window, not only open (total_due > 0)")
        .option("--months <n>", "Created-after window in months (default 6, max 12)", (v) => Number(v))
        .option("--asiakas <id>", "Target company override (e.g. 8 = Kalle Urho Oy verification path)", (v) => Number(v))
        .option("--refresh", "Bypass the server's 15-minute cache")
        .action(jsonAction(getClient, (client, opts) => runFennoaPurchases(client, opts)));
}
//# sourceMappingURL=index.js.map