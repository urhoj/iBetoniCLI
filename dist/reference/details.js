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
};
//# sourceMappingURL=details.js.map