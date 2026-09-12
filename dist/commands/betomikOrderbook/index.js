import { writeFlagsToHeaders, addWriteFlagsToCommand } from "../../api/writeFlags.js";
import { addJsonBodyOptions, resolveJsonBody } from "../_shared/jsonBody.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { writeJson } from "../../output/json.js";
import { listEnvelope } from "../../api/envelopes.js";
import { parseId } from "../../targets.js";
export async function runBetomikOrderbookImport(client, body, flags) {
    return client.post("/api/betomik-orderbook/import", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
function itemsOf(raw) {
    const items = raw?.items;
    return Array.isArray(items) ? items : [];
}
/** Import runs for the Betomik staging table, newest first (GET /api/betomik-orderbook/runs). */
export async function runBetomikOrderbookRuns(client) {
    const raw = await client.get("/api/betomik-orderbook/runs");
    return listEnvelope(itemsOf(raw));
}
/** Staging rows of one import run (GET /api/betomik-orderbook/runs/:runId/rows). */
export async function runBetomikOrderbookRows(client, runId) {
    const raw = await client.get(`/api/betomik-orderbook/runs/${runId}/rows`);
    return listEnvelope(itemsOf(raw));
}
export function registerBetomikOrderbookCommands(parent, getClient) {
    const group = parent
        .command("betomik-orderbook")
        .description("Betomik order-book import validator staging (developer only)");
    const importCmd = addJsonBodyOptions(group.command("import"));
    addWriteFlagsToCommand(importCmd).action(guarded(async (opts) => {
        const body = resolveJsonBody(importCmd, opts, { required: true });
        const client = await getClient();
        const result = await runBetomikOrderbookImport(client, body, opts);
        writeJson(result);
    }));
    group
        .command("runs")
        .description("List import runs (sheet label, ISO year/week, row count), newest first")
        .action(jsonAction(getClient, (client) => runBetomikOrderbookRuns(client)));
    group
        .command("rows <runId>")
        .description("Staging rows of one import run (plate, driver, source type, m3, review status)")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookRows(client, parseId(idStr, "runId"))));
}
//# sourceMappingURL=index.js.map