import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { resolveAsiakasTarget } from "../customer/index.js";
/**
 * Wrap a backend array into the universal `{ items, nextCursor, count }` list
 * envelope. The BetoniJerry endpoints return bare arrays (sendSuccess sends raw
 * data), so the CLI projects them client-side — the established pattern for
 * reads that reuse non-`/api/cli/` routes. Defensive against a non-array body.
 */
function toEnvelope(value) {
    const items = Array.isArray(value) ? value : [];
    return { items, nextCursor: null, count: items.length };
}
/**
 * List pump requests (tarjouspyynnöt). Two views:
 *   --open  → GET /api/pumppuRequests/open       (provider inbox; isProvider; PII masked until your offer is accepted)
 *   --mine  → GET /api/pumppuRequests/mine        (the caller's own requests; default)
 * `--status` (CSV) and `--limit` apply to the --mine view only. Projected into
 * the universal list envelope.
 */
export async function runJerryRequestList(client, opts) {
    if (opts.open) {
        return toEnvelope(await client.get("/api/pumppuRequests/open"));
    }
    const params = new URLSearchParams();
    if (opts.status)
        params.set("status", opts.status);
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    return toEnvelope(await client.get(`/api/pumppuRequests/mine${qs ? `?${qs}` : ""}`));
}
/**
 * Get a single pump request. Default is the customer-owned recap
 * (GET /api/pumppuRequests/:id). `--provider` switches to the provider-facing
 * detail (GET /api/pumppuRequests/:id/provider-detail; requires isProvider) —
 * customer PII stays masked there until this provider's offer is accepted.
 */
export async function runJerryRequestGet(client, id, asProvider) {
    const path = asProvider
        ? `/api/pumppuRequests/${id}/provider-detail`
        : `/api/pumppuRequests/${id}`;
    return client.get(path);
}
/**
 * List the offers on a customer-owned request (GET /api/pumppuRequests/:id/offers).
 * Provider contact fields (jerryContactName/Phone, openingHours) are revealed
 * only on the accepted offer row. Projected into the list envelope.
 */
export async function runJerryRequestOffers(client, id) {
    return toEnvelope(await client.get(`/api/pumppuRequests/${id}/offers`));
}
/**
 * Create or update (upsert) the caller's offer on a request
 * (POST /api/pumppuRequests/:id/offers). Provider-only. A new offer starts as
 * 'draft' (invisible to the customer) — transition it with `offer send`.
 * Re-running while still draft/pending edits the existing offer.
 */
export async function runJerryOfferCreate(client, id, body, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Send a draft offer (draft → pending; POST /:id/offers/:offerId/send) — makes
 * it visible to the customer. Provider-only; you must own the offer.
 */
export async function runJerryOfferSend(client, id, offerId, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers/${offerId}/send`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Accept an offer (customer-side; POST /:id/offers/:offerId/accept). Flips this
 * offer to 'accepted', sibling offers to 'rejected', and the request to
 * 'accepted'. Caller must own the request.
 */
export async function runJerryOfferAccept(client, id, offerId, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers/${offerId}/accept`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Confirm an accepted offer (provider-side; POST /:id/offers/:offerId/confirm).
 * Heavyweight: builds a keikka in the provider's grid. `scheduledAt` (future
 * ISO) is required; `pumppuId` optionally pins one of your vehicles.
 */
export async function runJerryOfferConfirm(client, id, offerId, body, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers/${offerId}/confirm`, body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Create a customer pump request / tarjouspyyntö (POST /api/pumppuRequests).
 * CUSTOMER side — distinct from `runJerryOfferCreate` (the provider bid). The
 * backend geocodes `osoite` and inserts the request as status:'open', visible
 * to every matching provider. Body keys are the Finnish field names the route
 * reads verbatim. `--dry-run` is deploy-gated (see the command notes).
 */
export async function runJerryRequestCreate(client, body, flags) {
    return client.post("/api/pumppuRequests", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Lifecycle counts. Default is the customer view (GET /api/pumppuRequests/mine/counts:
 * draft/open/pending_verification/accepted/cancelled/expired/no_supply).
 * `--provider` returns the provider badge counts (GET /api/pumppuRequests/provider-counts:
 * avoimet/tarjotut/voitetut/voitetutActionRequired/paattyneet; requires isProvider).
 */
export async function runJerryCounts(client, provider) {
    const path = provider
        ? "/api/pumppuRequests/provider-counts"
        : "/api/pumppuRequests/mine/counts";
    return client.get(path);
}
/**
 * Anonymous geofence feasibility probe (POST /api/pumppuRequests/checkAddress).
 * Answers "does any provider varikko cover this address?" — the root-cause tool
 * for "no offers". `--address` maps to the required `osoite` body field; if
 * `--lat`/`--lng`/`--place-id` are all supplied the server trusts them instead
 * of re-geocoding. Not a mutation, so no write-safety flags. The `providers`
 * array is only present when the caller's token is a developer/admin.
 */
export async function runJerryCheckAddress(client, opts) {
    const body = { osoite: opts.address };
    if (opts.lat !== undefined)
        body.lat = opts.lat;
    if (opts.lng !== undefined)
        body.lng = opts.lng;
    if (opts.placeId)
        body.placeId = opts.placeId;
    if (opts.formattedAddress)
        body.formattedAddress = opts.formattedAddress;
    return client.post("/api/pumppuRequests/checkAddress", body, { read: true });
}
// ─── provider settings ──────────────────────────────────────────────────────
/**
 * Read a provider company's BetoniJerry settings (GET /api/jerry-provider-settings).
 * Defaults to the caller's own company; `--asiakas` targets another company the
 * caller has edit rights on.
 */
export async function runJerryProviderSettingsGet(client, asiakasId) {
    const qs = asiakasId !== undefined ? `?asiakasId=${asiakasId}` : "";
    return client.get(`/api/jerry-provider-settings${qs}`);
}
/**
 * Upsert a provider company's BetoniJerry settings (PUT /api/jerry-provider-settings).
 * Partial-payload-safe: only the body keys present are written. `--asiakas` is
 * merged into the body to target a specific company. Write flags surface as the
 * universal headers.
 */
export async function runJerryProviderSettingsSet(client, body, asiakasId, flags) {
    const payload = asiakasId !== undefined ? { ...body, asiakasId } : body;
    return client.put("/api/jerry-provider-settings", payload, {
        headers: writeFlagsToHeaders(flags),
    });
}
// ─── admin (system-admin Jerry dashboard) ───────────────────────────────────
/** List Jerry-active companies with per-company counts (GET /api/admin/jerry-companies). System-admin only. */
export async function runJerryAdminList(client) {
    return toEnvelope(await client.get("/api/admin/jerry-companies"));
}
/** Search non-Jerry companies for the Add picker (GET /api/admin/jerry-companies/search?q=). System-admin only. */
export async function runJerryAdminSearch(client, q) {
    return toEnvelope(await client.get(`/api/admin/jerry-companies/search?q=${encodeURIComponent(q)}`));
}
/** Company drill-down: people by role, vehicles, sijainnit Jerry status (GET /api/admin/jerry-companies/:id/detail). System-admin only. */
export async function runJerryAdminDetail(client, asiakasId) {
    return client.get(`/api/admin/jerry-companies/${asiakasId}/detail`);
}
/**
 * Enable (`on=true`) or disable (`on=false`) the Jerry module for a company —
 * the audited toggle that sets both isPumppuToimittaja and the HAS_JERRY
 * setting (POST /api/admin/jerry-companies/:id/{enable,disable}). System-admin
 * only. Write flags surface as headers.
 */
export async function runJerryAdminToggle(client, asiakasId, on, flags) {
    const action = on ? "enable" : "disable";
    return client.post(`/api/admin/jerry-companies/${asiakasId}/${action}`, {}, { headers: writeFlagsToHeaders(flags) });
}
/** Enforce a required --reason at the CLI layer (exit 4), matching the lifecycle commands. */
function requireReason(opts) {
    if (!opts.reason) {
        failWith("Missing required flag: --reason", 4);
    }
}
/** Parse a tri-state boolean flag value ("true"/"1" → true, else false). */
function parseBool(v) {
    return v === "true" || v === "1";
}
/**
 * Resolve the worksite address from the positional OR the --address flag.
 * Exactly one is required; both are allowed only if they agree. (resolveTarget
 * is integer-only, so the dual-input is handled inline for this string field.)
 */
function resolveAddress(positional, flag) {
    const p = positional?.trim();
    const f = flag?.trim();
    if (p && f) {
        if (p !== f)
            failWith("Address given twice and they differ (positional vs --address)", 4);
        return p;
    }
    const v = p || f;
    if (!v)
        failWith("Missing required address (positional <address> or --address)", 4);
    return v;
}
/**
 * Register the `ib jerry` command group — the BetoniJerry marketplace surface:
 *   request list/get/offers   read tarjouspyynnöt + their offers
 *   counts                    lifecycle counts (customer or provider view)
 *   check-address             anonymous geofence feasibility probe
 *   provider-settings get/set per-provider Jerry config
 *   admin list/search/detail/enable/disable   system-admin Jerry dashboard
 *
 * All commands reuse the existing /api/pumppuRequests, /api/jerry-provider-settings
 * and /api/admin/jerry-companies routes — the CLI projects array responses into
 * the universal list envelope. Mutations accept --dry-run / --idempotency-key /
 * --reason; admin enable/disable + provider-settings set require --reason.
 *
 * Exit codes follow the universal contract via exitWithError (2 auth · 3 perm ·
 * 4 validation · 5 not-found · 6 server · 7 network · 1 generic).
 */
export function registerJerryCommands(parent, getClient) {
    const j = parent.command("jerry").description("BetoniJerry marketplace commands");
    // request ──────────────────────────────────────────────────────────────────
    const request = j.command("request").description("Pump requests (tarjouspyynnöt)");
    request
        .command("list")
        .description("List pump requests (--mine default, or --open provider inbox)")
        .option("--open", "Provider inbox: open requests (requires provider role)")
        .option("--mine", "Your own requests (default)")
        .option("--status <csv>", "Filter --mine by status (CSV)")
        .option("--limit <n>", "Max rows for --mine", (v) => Math.min(Number(v), 200))
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryRequestList(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    request
        .command("get <requestId>")
        .description("Get a single pump request (--provider for the provider-facing detail)")
        .option("--provider", "Use the provider-facing detail view (requires provider role)")
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryRequestGet(client, Number(idStr), !!opts.provider));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    request
        .command("offers <requestId>")
        .description("List the offers on a customer-owned request")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            writeJson(await runJerryRequestOffers(client, Number(idStr)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(request
        .command("create [address]")
        .description("Create a customer pump request (tarjouspyyntö). Address positional or --address. Requires --reason. ⚠ --dry-run is deploy-gated.")
        .option("--address <s>", "Worksite address (osoite); alias for the positional")
        .requiredOption("--pump-at <iso>", "Pump datetime (pumppausaika; ISO, e.g. 2026-06-17T09:00:00+03:00)")
        .requiredOption("--m3 <n>", "Concrete volume m³ (maaraM3; > 0)", Number)
        .option("--boom <m>", "Required boom reach m (puomi; default 0)", Number)
        .option("--duration <h>", "Pump duration hours (kesto)", Number)
        .option("--line-length <m>", "Hose line length m (linjanPituus)", Number)
        .option("--notes <s>", "Free-text description shown to providers (kuvaus)")
        .option("--asiakas <id>", "Customer asiakasId (omit → your private BetoniJerry account)", Number)).action(async (addressPositional, opts) => {
        requireReason(opts);
        const osoite = resolveAddress(addressPositional, opts.address);
        const maaraM3 = Number(opts.m3);
        if (!Number.isFinite(maaraM3) || maaraM3 <= 0) {
            failWith("--m3 must be a number > 0", 4);
        }
        const body = { osoite, pumppausaika: opts.pumpAt, maaraM3 };
        if (opts.boom !== undefined)
            body.puomi = opts.boom;
        if (opts.duration !== undefined)
            body.kesto = opts.duration;
        if (opts.lineLength !== undefined)
            body.linjanPituus = opts.lineLength;
        if (opts.notes)
            body.kuvaus = opts.notes;
        if (opts.asiakas !== undefined)
            body.asiakasId = opts.asiakas;
        try {
            const client = await getClient();
            writeJson(await runJerryRequestCreate(client, body, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // offer ──────────────────────────────────────────────────────────────────────
    const offer = j.command("offer").description("Act on offers (create/send/accept/confirm)");
    addWriteFlagsToCommand(offer
        .command("create <requestId>")
        .description("Create/update your draft offer on a request (provider). Requires --reason.")
        .requiredOption("--price-cents <n>", "Offer price in cents (integer 1..99999900)", Number)
        .option("--vat-percent <n>", "VAT percent (default 25.5)", Number)
        .option("--valid-until <iso>", "Offer valid-until (ISO datetime)")
        .option("--available-from <iso>", "Earliest availability (ISO datetime)")
        .option("--extra-notes <s>", "Free-text notes shown to the customer")
        .option("--cancellation-terms <s>", "Cancellation terms shown to the customer")
        .option("--maintains-order-info <bool>", "Override provider default (true|false)", parseBool)).action(async (idStr, opts) => {
        requireReason(opts);
        const priceCents = Number(opts.priceCents);
        if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99_999_900) {
            failWith("--price-cents must be an integer in 1..99999900", 4);
        }
        const body = { priceCents };
        if (opts.vatPercent !== undefined)
            body.vatPercent = opts.vatPercent;
        if (opts.validUntil)
            body.validUntil = opts.validUntil;
        if (opts.availableFrom)
            body.availableFrom = opts.availableFrom;
        if (opts.extraNotes)
            body.extraNotes = opts.extraNotes;
        if (opts.cancellationTerms)
            body.cancellationTerms = opts.cancellationTerms;
        if (opts.maintainsOrderInfo !== undefined)
            body.maintainsOrderInfo = opts.maintainsOrderInfo;
        try {
            const client = await getClient();
            writeJson(await runJerryOfferCreate(client, Number(idStr), body, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(offer
        .command("send <requestId> <offerId>")
        .description("Send a draft offer to the customer (draft → pending; provider). Requires --reason.")).action(async (idStr, offerIdStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryOfferSend(client, Number(idStr), Number(offerIdStr), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(offer
        .command("accept <requestId> <offerId>")
        .description("Accept an offer (customer-side). Rejects siblings + closes the request. Requires --reason.")).action(async (idStr, offerIdStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryOfferAccept(client, Number(idStr), Number(offerIdStr), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(offer
        .command("confirm <requestId> <offerId>")
        .description("Confirm an accepted offer → builds a keikka (provider). Requires --scheduled-at + --reason.")
        .requiredOption("--scheduled-at <iso>", "Scheduled keikka start (future ISO datetime)")
        .option("--pumppu <vehicleId>", "Pin one of your vehicles to the keikka", Number)).action(async (idStr, offerIdStr, opts) => {
        requireReason(opts);
        const body = { scheduledAt: opts.scheduledAt };
        if (opts.pumppu !== undefined)
            body.pumppuId = opts.pumppu;
        try {
            const client = await getClient();
            writeJson(await runJerryOfferConfirm(client, Number(idStr), Number(offerIdStr), body, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // counts ─────────────────────────────────────────────────────────────────────
    j.command("counts")
        .description("Lifecycle counts (--mine customer view default, or --provider)")
        .option("--provider", "Provider badge counts (requires provider role)")
        .option("--mine", "Customer counts (default)")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryCounts(client, !!opts.provider));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // check-address ────────────────────────────────────────────────────────────
    j.command("check-address")
        .description("Anonymous geofence feasibility probe (which provider varikot cover an address)")
        .requiredOption("--address <s>", "Street address to check (maps to `osoite`)")
        .option("--lat <n>", "Latitude (trusted only with --lng + --place-id)", Number)
        .option("--lng <n>", "Longitude (trusted only with --lat + --place-id)", Number)
        .option("--place-id <s>", "Google placeId (lets the server trust client coords)")
        .option("--formatted-address <s>", "Google formatted address")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryCheckAddress(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // provider-settings ──────────────────────────────────────────────────────────
    const ps = j
        .command("provider-settings")
        .description("Per-provider BetoniJerry settings (contact, opening hours, description)");
    ps.command("get")
        .description("Read a provider's Jerry settings (defaults to your company)")
        .option("--asiakas <id>", "Target company asiakasId", Number)
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryProviderSettingsGet(client, opts.asiakas));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(ps
        .command("set")
        .description("Upsert a provider's Jerry settings. Requires --reason.")
        .requiredOption("--body <json>", "JSON: { jerryPersonId?, openingHours?, companyDescription?, maintainsOrderInfo? }")
        .option("--asiakas <id>", "Target company asiakasId", Number)).action(async (opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            const parsed = parseJsonBodyFlag(opts.body);
            writeJson(await runJerryProviderSettingsSet(client, parsed, opts.asiakas, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // admin ──────────────────────────────────────────────────────────────────────
    const admin = j
        .command("admin")
        .description("System-admin Jerry dashboard (enable/disable + listings)");
    admin
        .command("list")
        .description("List Jerry-active companies with per-company counts")
        .action(async () => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminList(client));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    admin
        .command("search <query>")
        .description("Search non-Jerry companies (Add picker)")
        .action(async (query) => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminSearch(client, query));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    admin
        .command("detail [asiakasId]")
        .description("Company drill-down: people by role, vehicles, sijainnit Jerry status")
        .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)
        .action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminDetail(client, resolveAsiakasTarget(idStr, opts.asiakas)));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(admin
        .command("enable [asiakasId]")
        .description("Enable the Jerry module for a company (audited). Requires --reason.")
        .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)).action(async (idStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryAdminToggle(client, resolveAsiakasTarget(idStr, opts.asiakas), true, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(admin
        .command("disable [asiakasId]")
        .description("Disable the Jerry module for a company (audited). Requires --reason.")
        .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)).action(async (idStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryAdminToggle(client, resolveAsiakasTarget(idStr, opts.asiakas), false, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map