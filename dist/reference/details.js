/**
 * Curated on-demand business/AI context, keyed by full command path.
 *
 * Companion to `summaries.ts`: `summary` is the short always-loaded catalog line;
 * `detail` here is the deeper betoni.online business context the AI pulls ONLY when
 * it needs to verify a claim or understand the domain. Surfaced by
 * `ib reference detail <cmd>` and the `AI NOTES` section of `ib <cmd> --help`;
 * STRIPPED from `ib reference dump` (one-shot ingestion stays lean). Merged onto
 * COMMAND_SPECS in `specs.ts`. Doubles as AI documentation material.
 *
 * Filled incrementally by the `optimize-ib-summaries` skill (cycling batches),
 * which sources every fact from the impl/route/docs. Keys MUST match a real
 * command (enforced by `test/reference/details.test.ts`). Seeded here with two
 * worked exemplars that define the house style.
 */
/** Hard upper bound asserted by the details test (a loose guard; the curation soft target is ~1500). */
export const MAX_DETAIL_LEN = 2000;
export const COMMAND_DETAILS = {
    "ib keikka latest": "Keikka = yksi betonin toimitus-/pumppauskeikka — the central delivery/pump job. " +
        "'Latest' answers the dispatcher's recurring 'when did we last deliver/pump for X?' " +
        "without guessing a date range: it searches backwards from today over the same filters " +
        "as `ib keikka list`.\n\n" +
        "Reading 'delivered' correctly depends on keikkaTilaId: 9/12/13 = Toimitettu (delivered), " +
        "100 = Valmis (closed); -1/0 = Uusi/Luonnos (not real yet). To get the last DELIVERED " +
        "order, filter by a delivered status — otherwise you get the most recent row of ANY status.\n\n" +
        "Scope: tenant-scoped via ownerAsiakasId from your token; `ib company switch` changes what " +
        "'latest' sees. Same projection/backend as `ib keikka list`.",
    "ib jerry check-address": "BetoniJerry = RFQ marketplace for concrete pumping: a customer posts a tarjouspyyntö " +
        "(pumppuRequest), provider companies bid (pumppuOffer), the winner is confirmed into a keikka. " +
        "'No offers' is the classic failure — no provider varikko (depot) geofence-covers the address.\n\n" +
        "`check-address` is the diagnostic: it runs the same geofence feasibility probe the public " +
        "request flow uses (POST /api/pumppuRequests/checkAddress — the route is unauthenticated, but " +
        "ib sends your session). --address is required; if you also pass --lat/--lng/--place-id the " +
        "server trusts them instead of re-geocoding. Rate-limited 10/min per IP.\n\n" +
        "The `providers` array (which varikot cover the point) is returned only to developer/admin " +
        "tokens. Use it to explain a 'no offers' result: either no depot's delivery radius reaches the " +
        "address, or no covering provider is Jerry-enrolled (sijainti.jerryActiveUntil).",
    "ib keikka list": "Keikka = one concrete delivery/pumping job (tilaus) scheduled to a worksite. Each keikka " +
        "has a `pumppuAika` datetime; the CLI projects its date as `pvm` (YYYY-MM-DD) and time as HH:MM.\n\n" +
        "Date window: BOTH --from and --to default to today (Helsinki tz, resolved client-side). With no " +
        "flags you get today's keikkas only — NOT a rolling window. The echoed `range:{from,to}` makes an " +
        "empty result unambiguous (window was right, just no rows).\n\n" +
        "Fan-out gotcha: a keikka linked to multiple worksites returns ONE ROW PER tyomaa, so the same " +
        "keikkaId repeats with different tyomaaId. The envelope `count` counts rows, not distinct " +
        "deliveries — dedupe by keikkaId to count deliveries.\n\n" +
        "Status (keikkaTilaId): -1 Uusi · 0 Luonnos · 8 Peruttu · 9/12/13 Toimitettu · 100 Valmis " +
        "(full legend: GET /api/tila/list). `--status` takes the numeric value.\n\n" +
        "Scope: ownerAsiakasId comes from the JWT (never client-supplied); `ib company switch` changes " +
        "what you see. Server caps at 500 rows; `nextCursor` = last keikkaId when truncated.\n\n" +
        "Siblings: `ib schedule today` (no flags) for today; `ib keikka latest` for the most-recent match " +
        "without a date range; `ib keikka search` for phone/invoice-ref lookup. Source: GET /api/cli/keikka/list.",
    "ib worksite search": "Työmaa = a named delivery destination (construction site/address) owned by a company: up to four " +
        "address lines (street / aux / postal code / city), driving instructions (ajo-ohje), memo, formatted " +
        "geocoded address, worksite number (tyomaaNum), and contact persons.\n\n" +
        "Search breadth: the backend full-text-matches your query against the name, ALL FOUR address lines, " +
        "driving instructions, memo, formatted address, worksite number, AND each contact's name/phone/email " +
        "— so a partial street fragment ('Mannerheimintie') finds the worksite without its id or exact name.\n\n" +
        "Scope & safety: scoped to the active company by default; `--my-companies` fans out across every " +
        "company you belong to (rows tagged with ownerAsiakasId). The POST is sent with `{ read:true }` " +
        "(a non-mutating read, NOT a `meta` request), so it's safe under --read-only and never trips the " +
        "acting-as write line. Backend caps at 100 rows; CLI default 50.\n\n" +
        "Siblings: `ib worksite list` for plain cursor-paginated listing (no query); `ib search worksite` " +
        "for cross-entity fan-out. Route: POST /api/tyomaa/search (same as the FE typeahead); permission auth.page.tyomaa.read.",
    "ib stats": "Aggregates delivery stats (m³ volume, order counts, active vehicles/drivers) for a period via " +
        "`aggregateKeikkaStats`, which reads the grid SQL (listKeikkas_v7tenant_arrays) and sums in memory " +
        "— the SAME aggregator the AI getDailyStatistics tool uses. Route: GET /api/cli/stats (deploy-gated).\n\n" +
        "Breakdowns: with no --by you get the full bundle { period, totals:{orders,m3,activeVehicles," +
        "activeDrivers}, byStatus, byCustomer, byVehicle, byDriver, byWorksite, byDay }. `--by <dim>` returns " +
        "a ListEnvelope of just that breakdown; dims: customer|vehicle|driver|worksite|status|day. Period: " +
        "exactly one of --today (default) / --month YYYY-MM / --week <start> / --from … --to ….\n\n" +
        "Scope & gotchas: scoped to the caller's FULL visibility set (buildVisibilityArrays(user).any_aaid), " +
        "which can span multiple tenants — the cache key includes that whole set to avoid cross-user " +
        "collisions. byDriver can lag a driver reassignment by up to ~1h (PERSON_PVM_UPDATE doesn't sweep the " +
        "stats cache). byDriver.m3 DOUBLE-COUNTS on multi-driver keikkas (each driver credited the full keikka " +
        "m³), so sum(byDriver.m3) can exceed totals.m3. statusName is best-effort (keikkaTilaNimi) and usually " +
        "null. Revenue and driver hours are out of scope in v1.",
};
//# sourceMappingURL=details.js.map