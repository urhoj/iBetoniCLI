import { listEnvelope } from "../../api/envelopes.js";
import { qs } from "../../api/query.js";
import { jsonAction } from "../_shared/action.js";
import { intFlag } from "../../targets.js";
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
        .option("--all")
        .option("--months <n>", "", intFlag("--months"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--refresh")
        .action(jsonAction(getClient, (client, opts) => runFennoaPurchases(client, opts)));
}
//# sourceMappingURL=index.js.map