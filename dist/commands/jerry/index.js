import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { resolveAsiakasTarget } from "../customer/index.js";
import { parseId } from "../../targets.js";
import { resolveDate } from "../../dates.js";
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
 * List pump requests (tarjouspyynnöt). Three views:
 *   --mine     → GET /api/pumppuRequests/mine          (the caller's own requests; default)
 *   --open     → GET /api/pumppuRequests/open          (provider inbox; isProvider; PII masked until your offer is accepted)
 *   --provider → GET /api/pumppuRequests/provider-list (provider lifecycle; isProvider; incl. your sent offers),
 *                filtered by --tab (default avoimet): avoimet=open to bid on, tarjotut=offered (pending),
 *                voitetut=won (offer accepted/confirmed), paattyneet=ended (expired/no_supply/lost).
 * `--status` (CSV) and `--limit` apply to the --mine view only. Projected into
 * the universal list envelope.
 */
export async function runJerryRequestList(client, opts) {
    if (opts.provider) {
        const tab = opts.tab || "avoimet";
        const data = await client.get(`/api/pumppuRequests/provider-list?tab=${encodeURIComponent(tab)}`);
        const items = Array.isArray(data?.requests) ? data.requests : [];
        return { items, nextCursor: null, count: items.length };
    }
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
 * Withdraw your sent offer before the customer accepts it
 * (pending → withdrawn; POST /:id/offers/:offerId/withdraw). Provider-only; own offer.
 */
export async function runJerryOfferWithdraw(client, id, offerId, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers/${offerId}/withdraw`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Hard-delete your OWN DRAFT offer (DELETE /:id/offers/:offerId). Provider-only;
 * own offer; DRAFT status only — a sent offer 409s (use `offer withdraw` for
 * pending). Mirrors the request-draft delete; the offer's attachments are
 * soft-deleted server-side. Returns { success, pumppuOfferId, deleted } (or the
 * dry-run wouldDelete echo).
 */
export async function runJerryOfferDelete(client, id, offerId, flags) {
    return client.delete(`/api/pumppuRequests/${id}/offers/${offerId}`, {
        headers: writeFlagsToHeaders(flags),
    });
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
 * Cancel the caller's OWN request (customer-side; POST /api/pumppuRequests/:id/cancel).
 * Allowed only while no live offer exists (server enforces). Sets status 'cancelled'.
 */
export async function runJerryRequestCancel(client, id, flags) {
    return client.post(`/api/pumppuRequests/${id}/cancel`, {}, {
        headers: writeFlagsToHeaders(flags),
    });
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
 *
 * `--explain` adds a `considered[]` array of the varikot that did NOT match, each
 * with the FIRST gate that excluded it (no-coords / company-gate / not-enrolled /
 * radius / boom) — the "why no offers?" diagnostic. Like `providers`, it is
 * returned only to developer/admin tokens. `--asiakas <id>` force-includes one
 * (possibly not-yet-enabled) company's varikot so onboarding sees company-gate.
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
    if (opts.boom !== undefined)
        body.requiredPuomi = opts.boom;
    if (opts.explain)
        body.explain = true;
    if (opts.asiakas !== undefined)
        body.asiakasId = opts.asiakas;
    return client.post("/api/pumppuRequests/checkAddress", body, { read: true });
}
/**
 * Developer view of BetoniJerry supply coverage (GET /api/betonijerry/coverage-areas/detail;
 * developer/admin only — 403 otherwise). Returns the candidate-area coverage table
 * (covered + not, with providerCount) and the raw enrolled depot circles, then
 * derives a summary + the distinct covered regions (the ad-geo-targeting answer).
 */
export async function runJerryCoverage(client) {
    const data = await client.get("/api/betonijerry/coverage-areas/detail");
    const areas = Array.isArray(data?.areas) ? data.areas : [];
    const varikot = Array.isArray(data?.varikot) ? data.varikot : [];
    const coveredRegions = [];
    for (const a of areas) {
        if (a.covered && typeof a.tailRegion === "string" && !coveredRegions.includes(a.tailRegion)) {
            coveredRegions.push(a.tailRegion);
        }
    }
    const providerIds = new Set(varikot.map((v) => v.asiakasId));
    const computedAt = typeof data?.computedAt === "string" ? data.computedAt : null;
    return {
        summary: {
            varikkoCount: varikot.length,
            providerCount: providerIds.size,
            coveredAreas: areas.filter((a) => a.covered).length,
            coveredRegions,
        },
        coveredRegions,
        areas,
        varikot,
        computedAt,
    };
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
// ─── admin onboarding (provider-acquisition pipeline) ───────────────────────
/**
 * Valid onboarding pipeline status keys — mirrors backend ALL_STATUSES
 * (puminet5api modules/jerryAdmin/onboardingStatus.js); the server 400s on
 * anything else. Shared by the option help here and the CommandSpecs.
 */
export const ONBOARDING_STATUS_KEYS = "ei_aloitettu → email1_lahetetty → muistutus_lahetetty → vastasi_kylla → tiedot_pyydetty → tervetuloa_lahetetty (pipeline order); terminal: vastasi_ei / ei_vastausta / ei_sovellu";
/** Fields a `--search` substring matches against (company name + outreach/contact). */
const ONBOARDING_SEARCH_FIELDS = [
    "asiakasNimi",
    "outreachName",
    "outreachEmail",
    "contactPersonName",
    "contactPersonEmail",
];
/** List onboarding prospects (GET /api/admin/jerry-onboarding). System-admin only. */
export async function runJerryOnboardingList(client, opts = {}) {
    const params = new URLSearchParams();
    if (opts.status)
        params.set("status", opts.status);
    if (opts.tier !== undefined)
        params.set("tier", String(opts.tier));
    const qs = params.toString();
    const env = toEnvelope(await client.get(`/api/admin/jerry-onboarding${qs ? `?${qs}` : ""}`));
    let items = env.items;
    if (opts.search) {
        const needle = opts.search.toLowerCase();
        items = items.filter((r) => ONBOARDING_SEARCH_FIELDS.some((f) => {
            const v = r[f];
            return typeof v === "string" && v.toLowerCase().includes(needle);
        }));
    }
    if (opts.due)
        items = items.filter((r) => r.muistutusDue === true);
    if (items === env.items)
        return env;
    return { ...env, items, count: items.length };
}
/** Add a prospect (POST /api/admin/jerry-onboarding). System-admin only. */
export async function runJerryOnboardingAdd(client, asiakasId, fields, flags) {
    return client.post("/api/admin/jerry-onboarding", { asiakasId, ...fields }, { headers: writeFlagsToHeaders(flags) });
}
/** Partial-update a prospect (PUT /api/admin/jerry-onboarding/:id). System-admin only. */
export async function runJerryOnboardingSet(client, asiakasId, fields, flags) {
    return client.put(`/api/admin/jerry-onboarding/${asiakasId}`, fields, { headers: writeFlagsToHeaders(flags) });
}
/** Log a call/response/note event (POST /api/admin/jerry-onboarding/:id/events). */
export async function runJerryOnboardingLog(client, asiakasId, body, flags) {
    return client.post(`/api/admin/jerry-onboarding/${asiakasId}/events`, body, { headers: writeFlagsToHeaders(flags) });
}
/** Admin request list (GET /api/admin/jerry-requests). System-admin only. */
export async function runJerryAdminRequests(client, opts) {
    const params = new URLSearchParams();
    if (opts.status)
        params.set("status", opts.status);
    if (opts.from)
        params.set("from", opts.from);
    if (opts.to)
        params.set("to", opts.to);
    if (opts.customer !== undefined)
        params.set("customerId", String(opts.customer));
    if (opts.provider !== undefined)
        params.set("providerId", String(opts.provider));
    if (opts.limit !== undefined)
        params.set("limit", String(opts.limit));
    const qs = params.toString();
    const data = await client.get(`/api/admin/jerry-requests${qs ? `?${qs}` : ""}`);
    const items = Array.isArray(data?.requests) ? data.requests : [];
    return { items, nextCursor: null, count: items.length, truncated: !!data?.truncated };
}
/** One request's full detail, admin view (GET /api/admin/jerry-requests/:id). System-admin only. */
export async function runJerryAdminRequestGet(client, id) {
    return client.get(`/api/admin/jerry-requests/${id}`);
}
/** Offers on one request, admin view (GET /api/admin/jerry-requests/:id/offers). */
export async function runJerryAdminRequestOffers(client, id) {
    return toEnvelope(await client.get(`/api/admin/jerry-requests/${id}/offers`));
}
// ─── admin request write commands ────────────────────────────────────────────
/**
 * Factory for admin request status-transition commands (expire/cancel/resend).
 * POSTs to /api/admin/jerry-requests/:id/:action with write-safety headers.
 */
const adminReqWrite = (action) => (client, id, flags) => client.post(`/api/admin/jerry-requests/${id}/${action}`, {}, { headers: writeFlagsToHeaders(flags) });
/** Force-expire an open/no_supply/pending_verification request (POST /api/admin/jerry-requests/:id/expire). System-admin only. */
export const runJerryAdminRequestExpire = adminReqWrite("expire");
/** Cancel any request as admin (POST /api/admin/jerry-requests/:id/cancel). System-admin only. */
export const runJerryAdminRequestCancel = adminReqWrite("cancel");
/** Re-run provider fan-out for a request (POST /api/admin/jerry-requests/:id/resend). System-admin only. */
export const runJerryAdminRequestResend = adminReqWrite("resend");
/**
 * Extend a request's validity (POST /api/admin/jerry-requests/:id/extend). Sends
 * `until` (absolute ISO) when given, else `days` (omitted → backend default 14).
 * System-admin only.
 */
export async function runJerryAdminRequestExtend(client, id, opts) {
    const body = {};
    if (opts.until)
        body.until = opts.until;
    else if (opts.days != null)
        body.days = opts.days;
    return client.post(`/api/admin/jerry-requests/${id}/extend`, body, {
        headers: writeFlagsToHeaders(opts),
    });
}
/** Delete a draft request (admin; DELETE /api/admin/jerry-requests/:id). System-admin only. */
export async function runJerryAdminRequestDelete(client, id, flags) {
    return client.delete(`/api/admin/jerry-requests/${id}`, { headers: writeFlagsToHeaders(flags) });
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
        .option("--provider", "Provider lifecycle view via /provider-list (incl. your sent offers)")
        .option("--tab <tab>", "With --provider: avoimet|tarjotut|voitetut|paattyneet (default avoimet)")
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
            writeJson(await runJerryRequestGet(client, parseId(idStr, "requestId"), !!opts.provider));
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
            writeJson(await runJerryRequestOffers(client, parseId(idStr, "requestId")));
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
    addWriteFlagsToCommand(request
        .command("cancel <requestId>")
        .description("Cancel your OWN request (customer) — only while no offers received. Requires --reason.")).action(async (idStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryRequestCancel(client, parseId(idStr, "requestId"), opts));
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
        .option("--price-terms <s>", "Price-estimate terms (Hinta-arvion ehdot) shown to the customer")
        .option("--valid-until <iso>", "Offer valid-until (ISO datetime)")
        .option("--available-from <iso>", "Earliest availability (ISO datetime; stored, not shown on the BetoniJerry customer card)")
        .option("--extra-notes <s>", "Free-text notes shown to the customer")
        .option("--cancellation-terms <s>", "Per-offer cancellation terms (stored; BetoniJerry shows a platform-standard peruutusehdot, so this is NOT rendered on the customer card)")
        .option("--maintains-order-info <bool>", "Override provider default (true|false)", parseBool)).action(async (idStr, opts) => {
        requireReason(opts);
        const priceCents = Number(opts.priceCents);
        if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99_999_900) {
            failWith("--price-cents must be an integer in 1..99999900", 4);
        }
        const body = { priceCents };
        if (opts.vatPercent !== undefined)
            body.vatPercent = opts.vatPercent;
        if (opts.priceTerms)
            body.priceTerms = opts.priceTerms;
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
            writeJson(await runJerryOfferCreate(client, parseId(idStr, "requestId"), body, opts));
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
            writeJson(await runJerryOfferSend(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
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
            writeJson(await runJerryOfferAccept(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
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
            writeJson(await runJerryOfferConfirm(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), body, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(offer
        .command("withdraw <requestId> <offerId>")
        .description("Withdraw your sent offer before the customer accepts (pending → withdrawn; provider). Requires --reason.")).action(async (idStr, offerIdStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryOfferWithdraw(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(offer
        .command("delete <requestId> <offerId>")
        .description("Hard-delete your OWN DRAFT offer (provider; draft only — sent offers 409, use withdraw). Requires --reason.")).action(async (idStr, offerIdStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await runJerryOfferDelete(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
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
        .option("--boom <m>", "Required boom (m) — filters varikot by their puomiMin/puomiMax range (absent/0 = no boom filter)", Number)
        .option("--explain", "Add considered[] — per-varikko exclusion reasons for non-matching depots (developer/admin only)")
        .option("--asiakas <id>", "With --explain: force-include this company's varikot even if not yet Jerry-enabled (surfaces company-gate)", Number)
        .action(async (opts) => {
        // Reject a NaN --boom (e.g. Commander coercing "abc" → NaN) so the probe
        // fails loudly instead of silently dropping the boom filter the operator
        // asked for — misleading during onboarding verification.
        if (opts.boom !== undefined && (!Number.isFinite(opts.boom) || opts.boom < 0)) {
            failWith("--boom must be a non-negative number of metres", 4);
        }
        // --asiakas only makes sense alongside --explain (it scopes the considered[]
        // universe); reject a positive id without --explain so the operator isn't
        // silently ignored, and reject a non-positive-integer id like other targets.
        if (opts.asiakas !== undefined) {
            if (!Number.isInteger(opts.asiakas) || opts.asiakas <= 0) {
                failWith("--asiakas must be a positive integer asiakasId", 4);
            }
            if (!opts.explain) {
                failWith("--asiakas only applies with --explain", 4);
            }
        }
        try {
            const client = await getClient();
            writeJson(await runJerryCheckAddress(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // coverage ─────────────────────────────────────────────────────────────────
    j.command("coverage")
        .description("Developer view of BetoniJerry supply coverage — covered areas + enrolled depot circles")
        .action(async () => {
        try {
            const client = await getClient();
            writeJson(await runJerryCoverage(client));
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
        .option("--body <json>", "JSON: { jerryPersonId?, openingHours?, companyDescription?, maintainsOrderInfo? }")
        .option("--from-json <file>", "Read the JSON body from a file (or - for stdin) — shell-safe alternative to --body")
        .option("--asiakas <id>", "Target company asiakasId", Number)).action(async (opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson });
            if (!parsed) {
                failWith("provider-settings set requires a body via --body or --from-json", 4);
            }
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
    // admin onboarding — provider-acquisition pipeline ──────────────────────────
    const onboarding = admin
        .command("onboarding")
        .description("Provider onboarding pipeline (prospects + contact history)");
    onboarding
        .command("list")
        .description("List onboarding prospects with live Jerry status and reminder-due flag")
        .option("--status <key>", `Filter by pipeline status key: ${ONBOARDING_STATUS_KEYS}`)
        .option("--tier <n>", "Filter by tier (1/2)", Number)
        .option("--due", "Only rows where the email1b reminder is due")
        .option("--search <text>", "Case-insensitive substring on company name / outreach / contact fields")
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryOnboardingList(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const pickProspectFields = (o) => {
        const out = {};
        if (o.tier !== undefined)
            out.tier = o.tier;
        if (o.malli !== undefined)
            out.malli = o.malli;
        if (o.kanava !== undefined)
            out.kanava = o.kanava;
        if (o.alue !== undefined)
            out.alue = o.alue;
        if (o.status !== undefined)
            out.status = o.status;
        if (o.notes !== undefined)
            out.muistiinpanot = o.notes;
        if (o.outreachName !== undefined)
            out.outreachName = o.outreachName;
        if (o.outreachEmail !== undefined)
            out.outreachEmail = o.outreachEmail;
        if (o.outreachPhone !== undefined)
            out.outreachPhone = o.outreachPhone;
        return out;
    };
    addWriteFlagsToCommand(onboarding
        .command("add <asiakasId>")
        .description("Add a company to the onboarding pipeline")
        .option("--tier <n>", "1 = priority, 2 = secondary", Number)
        .option("--malli <v>", "Email variant (A/B)")
        .option("--kanava <text>", "Preferred channel")
        .option("--alue <text>", "Operating area ({alue} merge field)")
        .option("--source <s>", "manual|import|scheduled (default manual)")).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryOnboardingAdd(client, resolveAsiakasTarget(idStr, undefined), { ...pickProspectFields(opts), ...(opts.source !== undefined ? { source: opts.source } : {}) }, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(onboarding
        .command("set <asiakasId>")
        .description("Partial-update a prospect (status, tier, notes, outreach contact)")
        .option("--status <key>", `Pipeline status key: ${ONBOARDING_STATUS_KEYS}`)
        .option("--tier <n>", "1/2", Number)
        .option("--malli <v>", "Email variant (A/B)")
        .option("--kanava <text>", "Preferred channel")
        .option("--alue <text>", "Operating area")
        .option("--notes <text>", "muistiinpanot")
        .option("--outreach-name <text>", "Contact override name")
        .option("--outreach-email <email>", "Contact override email")
        .option("--outreach-phone <phone>", "Contact override phone")).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryOnboardingSet(client, resolveAsiakasTarget(idStr, undefined), pickProspectFields(opts), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(onboarding
        .command("log <asiakasId>")
        .description("Log a call/response/note event (optionally set status atomically)")
        .requiredOption("--type <t>", "call | response | note")
        .requiredOption("--text <text>", "Event text")
        .option("--time <iso>", "Backdated event time (ISO 8601)")
        .option("--set-status <key>", `Also set the pipeline status. Keys: ${ONBOARDING_STATUS_KEYS}`)).action(async (idStr, opts) => {
        try {
            const client = await getClient();
            const body = { eventType: opts.type, eventText: opts.text };
            if (opts.time !== undefined)
                body.eventTime = opts.time;
            if (opts.setStatus !== undefined)
                body.setStatus = opts.setStatus;
            writeJson(await runJerryOnboardingLog(client, resolveAsiakasTarget(idStr, undefined), body, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    // admin request — lifecycle subgroup (reads + write transitions) ─────────────
    const adminRequest = admin
        .command("request")
        .description("Admin tarjouspyyntö lifecycle (list/get/offers/expire/cancel/resend/extend/delete)");
    adminRequest
        .command("list")
        .description("System-wide tarjouspyyntö list with offer summary (filters)")
        .option("--status <csv>", "Status filter CSV (open,accepted,...)")
        .option("--from <date>", "createdAt from (YYYY-MM-DD / today / yesterday)", resolveDate)
        .option("--to <date>", "createdAt to (inclusive)", resolveDate)
        .option("--customer <id>", "Filter by customer asiakasId", Number)
        .option("--provider <id>", "Filter by provider asiakasId", Number)
        .option("--limit <n>", "Max rows (max 300)", (v) => Math.min(Number(v), 300))
        .action(async (opts) => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminRequests(client, opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    adminRequest
        .command("get <requestId>")
        .description("One request's full detail (admin view)")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminRequestGet(client, parseId(idStr, "requestId")));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    adminRequest
        .command("offers <requestId>")
        .description("All offers on one request (admin view, no masking)")
        .action(async (idStr) => {
        try {
            const client = await getClient();
            writeJson(await runJerryAdminRequestOffers(client, parseId(idStr, "requestId")));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    const adminReqAction = (name, desc, run) => addWriteFlagsToCommand(adminRequest.command(`${name} <requestId>`).description(desc))
        .action(async (idStr, opts) => {
        requireReason(opts);
        try {
            const client = await getClient();
            writeJson(await run(client, parseId(idStr, "requestId"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    adminReqAction("expire", "Force-expire a request (admin). Requires --reason.", runJerryAdminRequestExpire);
    adminReqAction("cancel", "Cancel any request (admin). Requires --reason.", runJerryAdminRequestCancel);
    adminReqAction("resend", "Re-run provider fan-out for a request (admin). Requires --reason.", runJerryAdminRequestResend);
    adminReqAction("delete", "Delete a draft request (admin). Requires --reason.", runJerryAdminRequestDelete);
    // extend needs --days/--until, so it is registered outside adminReqAction.
    addWriteFlagsToCommand(adminRequest
        .command("extend <requestId>")
        .description("Extend a request's validity / reactivate it (admin). Requires --reason.")
        .option("--days <n>", "Make it valid for N more days from now (default 14)", Number)
        .option("--until <date>", "Absolute new expiry (ISO date/datetime)")).action(async (idStr, opts) => {
        requireReason(opts);
        if (opts.days != null && opts.until)
            failWith("Pass either --days or --until, not both", 4);
        try {
            const client = await getClient();
            writeJson(await runJerryAdminRequestExtend(client, parseId(idStr, "requestId"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map