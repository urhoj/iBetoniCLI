import { listEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { parseOptionalId } from "../../targets.js";
const BRIEF_OMIT = ["analysis", "pitchAngle"];
/**
 * GET /api/admin/sales-prospects, shaped CLIENT-SIDE. The route deliberately
 * takes no query params (one fetch, filter locally — see the route comment), so
 * every option here is applied after the fetch.
 */
export async function runProspectList(client, opts = {}) {
    const rows = await client.get("/api/admin/sales-prospects");
    let all = Array.isArray(rows) ? rows : [];
    if (opts.status)
        all = all.filter((r) => r.status === opts.status);
    if (opts.tier !== undefined)
        all = all.filter((r) => r.tier === opts.tier);
    if (opts.segment)
        all = all.filter((r) => r.segment === opts.segment);
    if (opts.search) {
        const needle = opts.search.toLowerCase();
        all = all.filter((r) => [r.companyName, r.ytunnus, r.region].some((v) => String(v ?? "").toLowerCase().includes(needle)));
    }
    if (opts.brief) {
        all = all.map((r) => {
            const out = { ...r };
            for (const k of BRIEF_OMIT)
                delete out[k];
            return out;
        });
    }
    return listEnvelope(all);
}
/** Resolve one prospect by id, --asiakas or --ytunnus. Exit 4 when ambiguous, 5 when absent. */
export async function resolveProspect(client, ref) {
    // Guarded HERE, not at each call site: an all-undefined ref would otherwise
    // fall through to the ytunnus branch, where normYtunnus(undefined) === "" and
    // matches every row with a blank ytunnus.
    if (ref.id === undefined && ref.asiakas === undefined && !ref.ytunnus) {
        failWith("Pass a saasProspectId, --asiakas <id> or --ytunnus <y>", 4);
    }
    const rows = await client.get("/api/admin/sales-prospects");
    const all = Array.isArray(rows) ? rows : [];
    // Y-tunnus rendering varies by source: seeded rows took theirs from `asiakas`
    // (hyphenated, "1869376-5"), the weekly registry-scrape task takes theirs from
    // markdown (sometimes unhyphenated, "18693765"). Compare digits-only so both
    // resolve to the same row — an exact-string miss here used to exit 5 and send
    // the weekly task down the `add` path, creating a duplicate prospect for a
    // company already in the pipeline. Digit-only normalization is for THIS
    // lookup only; stored values are left exactly as provided.
    const normYtunnus = (v) => String(v ?? "").replace(/\D/g, "");
    const matches = ref.id !== undefined
        ? all.filter((r) => r.saasProspectId === ref.id)
        : ref.asiakas !== undefined
            ? all.filter((r) => r.asiakasId === ref.asiakas)
            : all.filter((r) => normYtunnus(r.ytunnus) === normYtunnus(ref.ytunnus));
    if (matches.length === 0) {
        failWith(`No sales prospect matches ${JSON.stringify(ref)}`, 5);
    }
    if (matches.length > 1) {
        // Never guess: two rows for one ytunnus means the data needs fixing, and
        // picking one would write the analysis onto an arbitrary half of it.
        failWith(`Ambiguous: ${matches.length} prospects match ${JSON.stringify(ref)} (ids ${matches
            .map((m) => m.saasProspectId)
            .join(", ")}) — pass the saasProspectId`, 4);
    }
    return matches[0];
}
export async function runProspectUpdate(client, saasProspectId, fields, flags) {
    return client.put(`/api/admin/sales-prospects/${saasProspectId}`, { ...fields, scope: "task" }, { headers: writeFlagsToHeaders(flags) });
}
export async function runProspectAdd(client, body, flags) {
    return client.post("/api/admin/sales-prospects", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
export async function runCustomerList(client) {
    const rows = await client.get("/api/admin/sales-customers");
    return listEnvelope(Array.isArray(rows) ? rows : []);
}
export function registerSalesCommands(parent, getClient) {
    const s = parent
        .command("sales")
        .description("betoni.online SaaS sales pipeline (system admin) — prospects + the companies actually running keikkaa. NOT `jerry admin onboarding`, which is the BetoniJerry provider pipeline.");
    const prospect = s.command("prospect").description("SaaS sales prospects (dbo.saasProspect)");
    prospect
        .command("list")
        .option("--status <s>")
        .option("--tier <n>", "", (v) => Number(v))
        .option("--segment <s>")
        .option("--search <text>")
        .option("--brief", "omit analysis + pitchAngle (the two long columns)")
        .action(jsonAction(getClient, (client, opts) => runProspectList(client, opts)));
    prospect
        .command("get [saasProspectId]")
        .option("--asiakas <id>", "", (v) => Number(v))
        .option("--ytunnus <y>")
        .action(guarded(async (idArg, opts) => {
        const client = await getClient();
        const id = parseOptionalId(idArg, "saasProspectId");
        writeJson(await resolveProspect(client, { id, asiakas: opts.asiakas, ytunnus: opts.ytunnus }));
    }));
    const addCmd = prospect
        .command("add")
        .option("--asiakas <id>", "", (v) => Number(v))
        .option("--name <s>")
        .option("--ytunnus <y>")
        .option("--segment <s>")
        .option("--tier <n>", "", (v) => Number(v))
        .option("--region <s>");
    addWriteFlagsToCommand(addCmd).action(guarded(async (opts) => {
        if (opts.asiakas === undefined && !opts.name) {
            failWith("Pass --asiakas <id> or --name \"<company>\"", 4);
        }
        const client = await getClient();
        writeJson(await runProspectAdd(client, {
            asiakasId: opts.asiakas,
            companyName: opts.name,
            ytunnus: opts.ytunnus,
            segment: opts.segment,
            tier: opts.tier,
            region: opts.region,
            source: "scheduled",
        }, opts));
    }));
    const updateCmd = prospect
        .command("update [saasProspectId]")
        .option("--asiakas <id>", "", (v) => Number(v))
        .option("--ytunnus <y>")
        .option("--name <s>")
        .option("--segment <s>")
        .option("--region <s>")
        .option("--fleet-pumps <n>", "", (v) => Number(v))
        .option("--staff <n>", "", (v) => Number(v))
        .option("--revenue <eur>", "", (v) => Number(v))
        .option("--revenue-year <y>", "", (v) => Number(v))
        .option("--current-system <s>")
        .option("--analysis <text>")
        .option("--fit-score <n>", "", (v) => Number(v))
        .option("--pitch <text>")
        // The shell-safe route for long Finnish prose. `--from-json` is NOT part of
        // addWriteFlagsToCommand (that adds only --dry-run/--idempotency-key/--reason),
        // so it is declared here — and the weekly task depends on it: PowerShell splits
        // an argument on its inner double quotes and silently expands backticks, both
        // of which an --analysis paragraph is full of.
        .option("--body <json>")
        .option("--from-json <file|->");
    addWriteFlagsToCommand(updateCmd).action(guarded(async (idArg, opts) => {
        const client = await getClient();
        const id = parseOptionalId(idArg, "saasProspectId");
        const row = await resolveProspect(client, { id, asiakas: opts.asiakas, ytunnus: opts.ytunnus });
        // Typed flags win over the JSON document — the same precedence as
        // buildOhjeFields/buildSijaintiBody, so a one-off override on the command
        // line does not need the file edited.
        const parsed = (resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson })
            ?? {});
        const fields = {
            companyName: opts.name ?? parsed.companyName,
            // JSON-document only: --ytunnus is a resolve-by KEY on this command
            // (which row to update), never a value to WRITE, so it must not be
            // merged in here the way the other typed flags are.
            ytunnus: parsed.ytunnus,
            segment: opts.segment ?? parsed.segment,
            region: opts.region ?? parsed.region,
            fleetPumps: opts.fleetPumps ?? parsed.fleetPumps,
            staffCount: opts.staff ?? parsed.staffCount,
            revenueEur: opts.revenue ?? parsed.revenueEur,
            revenueYear: opts.revenueYear ?? parsed.revenueYear,
            currentSystem: opts.currentSystem ?? parsed.currentSystem,
            analysis: opts.analysis ?? parsed.analysis,
            fitScore: opts.fitScore ?? parsed.fitScore,
            pitchAngle: opts.pitch ?? parsed.pitchAngle,
        };
        writeJson(await runProspectUpdate(client, row.saasProspectId, fields, opts));
    }));
    const customer = s
        .command("customer")
        .description("Companies with their own keikka rows — who is actually running betoni.online");
    customer
        .command("list")
        .action(jsonAction(getClient, (client) => runCustomerList(client)));
}
//# sourceMappingURL=index.js.map