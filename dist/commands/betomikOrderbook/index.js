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
/** Review one staging row (POST /api/betomik-orderbook/rows/:rowId/review). */
export async function runBetomikOrderbookReview(client, rowId, body, flags) {
    return client.post(`/api/betomik-orderbook/rows/${rowId}/review`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Run the AI proposer over one run (POST /api/betomik-orderbook/runs/:runId/propose). */
export async function runBetomikOrderbookPropose(client, runId, body, flags) {
    return client.post(`/api/betomik-orderbook/runs/${runId}/propose`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** AI-vs-human agreement for one run (GET /api/betomik-orderbook/runs/:runId/ai-stats). */
export async function runBetomikOrderbookAiStats(client, runId) {
    return client.get(`/api/betomik-orderbook/runs/${runId}/ai-stats`);
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
    const reviewCmd = group
        .command("review <rowId>")
        .description("Review one staging row: set status, optionally override keikka/palkki + palkki type")
        .requiredOption("--status <status>", "pending | approved | rejected")
        .option("--row-kind <kind>", "keikka | palkki")
        .option("--palkki-type <name>", "one of the tenant's grid_palkkiTypes names")
        .option("--note <text>", "reviewNotes");
    addWriteFlagsToCommand(reviewCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = { status: opts.status };
        if (opts.rowKind)
            body.rowKind = opts.rowKind;
        if (opts.palkkiType)
            body.palkkiType = opts.palkkiType;
        if (opts.note)
            body.notes = opts.note;
        writeJson(await runBetomikOrderbookReview(client, parseId(idStr, "rowId"), body, opts));
    }));
    const proposeCmd = group
        .command("propose <runId>")
        .description("Run the AI proposer over one run (stores a proposal per row in aiJson)")
        .option("--provider <name>", "bedrock (default) | local")
        .option("--force", "Re-propose rows that already carry a proposal");
    addWriteFlagsToCommand(proposeCmd).action(guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = {};
        if (opts.provider)
            body.provider = opts.provider;
        if (opts.force)
            body.force = true;
        writeJson(await runBetomikOrderbookPropose(client, parseId(idStr, "runId"), body, opts));
    }));
    group
        .command("ai-stats <runId>")
        .description("AI-vs-human agreement for one run's approved rows")
        .action(jsonAction(getClient, (client, idStr) => runBetomikOrderbookAiStats(client, parseId(idStr, "runId"))));
}
//# sourceMappingURL=index.js.map