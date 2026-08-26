import { listEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { parseOptionalId, intFlag } from "../../targets.js";
const BRIEF_OMIT = ["analysis", "pitchAngle"];
/**
 * Segment filter parity with the Myynti UI (fb#817). puminet4
 * salesProspectFilters.js treats the buckets as UNIONS, not exact matches:
 * 'pumppu'/'betoni' mean value-OR-all, and 'muu' doubles as the not-yet-typed
 * bucket (unset OR muu). Exact equality here used to return a different set
 * than the UI for the same filter name — `--segment muu` missed every row
 * still NULL, which is precisely the bucket that filter exists to surface.
 * Any other value (e.g. an explicit `all`) stays an exact match.
 */
function segmentMatches(segment, filter) {
    if (filter === "pumppu" || filter === "betoni")
        return segment === filter || segment === "all";
    if (filter === "muu")
        return !segment || segment === "muu";
    return segment === filter;
}
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
    if (opts.segment) {
        const segmentFilter = opts.segment;
        all = all.filter((r) => segmentMatches(r.segment, segmentFilter));
    }
    if (opts.search) {
        // `.trim()` matches the Myynti UI (`q.trim().toLowerCase()`,
        // salesProspectFilters.js) — without it a padded search box and a padded
        // `--search` disagree, which is exactly the parity fb#817 exists to keep.
        const needle = opts.search.trim().toLowerCase();
        // Union of the UI's fields (companyName + asiakasNimi, fb#817) and this
        // command's original ones (ytunnus + region), so a name typed into Myynti
        // and a name typed here can never disagree.
        all = all.filter((r) => [r.companyName, r.asiakasNimi, r.ytunnus, r.region].some((v) => String(v ?? "").toLowerCase().includes(needle)));
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
    // matches every row with a blank ytunnus. Whitespace-only is empty too
    // (fb#819): normYtunnus(" ") === "" would match an arbitrary row whose stored
    // ytunnus is null, so the guard rejects it before the lookup runs.
    if (ref.id === undefined && ref.asiakas === undefined && !ref.ytunnus?.trim()) {
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
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--ytunnus <y>")
        .action(jsonAction(getClient, (client, idArg, opts) => resolveProspect(client, {
        id: parseOptionalId(idArg, "saasProspectId"),
        asiakas: opts.asiakas,
        ytunnus: opts.ytunnus,
    })));
    const addCmd = prospect
        .command("add")
        .option("--asiakas <id>", "", intFlag("--asiakas"))
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
        .option("--asiakas <id>", "", intFlag("--asiakas"))
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