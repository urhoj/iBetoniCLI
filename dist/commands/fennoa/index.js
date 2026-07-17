import { writeJson, exitWithError } from "../../output/json.js";
/** Build a `?k=v&...` query suffix from defined params (one idiom for all reads). */
function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined)
            u.set(k, String(v));
    }
    const s = u.toString();
    return s ? `?${s}` : "";
}
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
        items,
        nextCursor: null,
        count: items.length,
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
        .description("Open purchase invoices (payables) fetched live from Fennoa — default target PumiNet Oy (asiakasId 26). System-admin only; result cached 15 min server-side.")
        .option("--all", "Include settled invoices in the window, not only open (total_due > 0)")
        .option("--months <n>", "Created-after window in months (default 6, max 12)", (v) => Number(v))
        .option("--asiakas <id>", "Target company override (e.g. 8 = Kalle Urho Oy verification path)", (v) => Number(v))
        .option("--refresh", "Bypass the server's 15-minute cache")
        .action(async (opts) => {
        try {
            writeJson(await runFennoaPurchases(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map