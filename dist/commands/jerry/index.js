import { Option } from "commander";
import { listEnvelope, toListEnvelope } from "../../api/envelopes.js";
import { writeFlagsToHeaders, addWriteFlagsToCommand, } from "../../api/writeFlags.js";
import { writeJson, failWith } from "../../output/json.js";
import { resolveJsonObjectBody } from "../../api/parseBody.js";
import { parseId, resolveSearchQuery, resolveDualString, resolveAsiakasTarget, cappedInt, intFlag, numFlag, addAsiakasTargetOption, assertEnum, assertEnumCsv, assertPositiveInt, queryAliasOption } from "../../targets.js";
import { resolveDate, resolveDateTime } from "../../dates.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { qs } from "../../api/query.js";
/**
 * Unwrap a `{ <key>: Row[] }` response into the list envelope. `extra`
 * (`{ truncated }`) is appended only when the caller supplies it — the
 * provider-list branch deliberately emits NO truncated key, while the two
 * admin lists always report the backend's boolean.
 */
const keyedListEnvelope = (data, key, extra) => {
    const rows = data?.[key];
    return listEnvelope(Array.isArray(rows) ? rows : [], extra);
};
// â”€â”€â”€ request reads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Tabs the provider lifecycle view (`--provider`) accepts — mirrors the
 * backend's VALID_TABS (puminet5api routes/pumppuRequestRoutes.js), which 400s
 * ("tab virheellinen") on anything else. Shared with the CommandSpec.
 */
export const PROVIDER_LIST_TABS = ["avoimet", "tarjotut", "voitetut", "paattyneet"];
/**
 * List pump requests (tarjouspyynnÃ¶t). Three views:
 *   --mine     â†’ GET /api/pumppuRequests/mine          (the caller's own requests; default)
 *   --open     â†’ GET /api/pumppuRequests/open          (provider inbox; isProvider; PII masked until your offer is accepted)
 *   --provider â†’ GET /api/pumppuRequests/provider-list (provider lifecycle; isProvider; incl. your sent offers),
 *                filtered by --tab (default avoimet): avoimet=open to bid on, tarjotut=offered (pending),
 *                voitetut=won (offer accepted/confirmed), paattyneet=ended (expired/no_supply/lost).
 * `--status` (CSV) and `--limit` apply to the --mine view only. Projected into
 * the universal list envelope.
 */
export async function runJerryRequestList(client, opts) {
    if (opts.provider) {
        const tab = opts.tab || "avoimet";
        const data = await client.get(`/api/pumppuRequests/provider-list${qs({ tab })}`);
        return keyedListEnvelope(data, "requests");
    }
    if (opts.open) {
        return toListEnvelope(await client.get("/api/pumppuRequests/open"));
    }
    return toListEnvelope(await client.get(`/api/pumppuRequests/mine${qs({ status: opts.status || undefined, limit: opts.limit })}`));
}
/**
 * Get a single pump request. Default is the customer-owned recap
 * (GET /api/pumppuRequests/:id). `--provider` switches to the provider-facing
 * detail (GET /api/pumppuRequests/:id/provider-detail; requires isProvider) —
 * which reveals the FULL customer lead (name, address, lat/lng, phone, email) to
 * every matched provider while the request is open. Masking lives on the `--open`
 * list and the fan-out email, not here.
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
    return toListEnvelope(await client.get(`/api/pumppuRequests/${id}/offers`));
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
 * Send a draft offer (draft â†’ pending; POST /:id/offers/:offerId/send) — makes
 * it visible to the customer. Provider-only; you must own the offer.
 */
export async function runJerryOfferSend(client, id, offerId, flags) {
    return client.post(`/api/pumppuRequests/${id}/offers/${offerId}/send`, {}, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Withdraw your sent offer before the customer accepts it
 * (pending â†’ withdrawn; POST /:id/offers/:offerId/withdraw). Provider-only; own offer.
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
 * Decline a whole request (provider-side; POST /api/pumppuRequests/:id/decline).
 * The caller's company bows out WITHOUT making an offer; `reason` (also carried as
 * the audit X-Action-Reason) is stored and shown to the customer, who is notified
 * (email + push). Blocked (409) if the caller already has an active offer — use
 * `offer withdraw` instead. Idempotent. The request leaves the provider's Avoimet
 * tab. Requires provider role.
 */
export async function runJerryRequestDecline(client, id, reason, flags) {
    return client.post(`/api/pumppuRequests/${id}/decline`, { reason: reason ?? null }, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Reverse a prior decline (provider-side; POST /api/pumppuRequests/:id/undecline).
 * The request returns to the caller's Avoimet tab and is offerable again. Idempotent
 * (a no-op success when there was no decline). No customer notification. Provider role.
 */
export async function runJerryRequestUndecline(client, id, flags) {
    return client.post(`/api/pumppuRequests/${id}/undecline`, {}, {
        headers: writeFlagsToHeaders(flags),
    });
}
/**
 * Create a customer pump request / tarjouspyyntÃ¶ (POST /api/pumppuRequests).
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
 * Weekly marketplace funnel (GET /api/admin/jerry-searches/weekly). System-admin only.
 *
 * The trend counterpart to `counts`: where `counts` is a lifecycle snapshot of
 * your own requests, this is the whole funnel week by week — visitors, address
 * searches, wizard sessions, requests, offers — so a change in demand or a
 * provider side that has gone quiet is visible as a shape, not a single number.
 */
export async function runJerryStats(client, weeks) {
    return client.get(`/api/admin/jerry-searches/weekly${qs({ weeks })}`);
}
/** Exclusion reasons `--explain` can report, in gate-priority order. */
export const CHECK_ADDRESS_GATES = [
    "company-gate",
    "provider-dead",
    "no-coords",
    "not-enrolled",
    "radius",
    "boom",
];
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
    if (opts.gate?.length)
        body.gates = opts.gate;
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
export async function runJerryEmailActivity(client, opts = {}) {
    return client.get(`/api/betonijerry/email-activity${qs({ days: opts.days ?? undefined, domain: opts.domain || undefined })}`);
}
// â”€â”€â”€ provider settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Read a provider company's BetoniJerry settings (GET /api/jerry-provider-settings).
 * Defaults to the caller's own company; `--asiakas` targets another company the
 * caller has edit rights on.
 */
export async function runJerryProviderSettingsGet(client, asiakasId) {
    return client.get(`/api/jerry-provider-settings${qs({ asiakasId })}`);
}
/**
 * Merge the typed `--email` flag over a parsed --body/--from-json patch (typed
 * flag wins) into the /api/jerry-provider-settings body. Mirrors
 * buildWorksiteUpdateBody / buildPersonUpdateBody (fb#234).
 *
 * Compared against `undefined`, NOT falsiness: `--email ""` is the documented
 * way to CLEAR the address. The backend normalises the empty string to NULL and
 * resolveProviderRecipients then falls back to the contact person's own address,
 * so an empty string must survive all the way through. A truthiness check here
 * would silently drop the clear and leave the old address delivering — which is
 * exactly why this lives in a tested pure function rather than inline in the
 * action, where the suite cannot reach it (tests never spawn the CLI).
 */
export function buildJerryProviderSettingsBody(parsedBody, typed) {
    const body = { ...(parsedBody ?? {}) };
    // Typed flag wins over the same key in --body: it is the more specific
    // instruction, and silently ignoring it would be the worse failure.
    if (typed.email !== undefined)
        body.offerNotificationEmail = typed.email;
    return body;
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
// â”€â”€â”€ admin (system-admin Jerry dashboard) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * List Jerry-active companies with per-company counts (GET /api/admin/jerry-companies).
 * System-admin only.
 *
 * `withNotification` adds the RESOLVED tarjouspyyntÃ¶ recipient per row
 * (notificationSource / notificationEmail / notificationRecipientCount) — the
 * fleet-wide "which address does each provider's notification actually reach?"
 * in one call (fb#567). Opt-in: it costs the backend extra queries per company.
 */
export async function runJerryAdminList(client, withNotification = false) {
    return toListEnvelope(await client.get(`/api/admin/jerry-companies${qs({ withNotification: withNotification ? 1 : undefined })}`));
}
/**
 * Companies for an "Add company" picker (GET /api/admin/jerry-companies/search).
 * System-admin only.
 *
 * Jerry-active companies are EXCLUDED by default, which is what the Jerry-enable
 * and onboarding pickers want — their job is to add Jerry to a company that lacks
 * it. `includeJerryActive` drops that exclusion, for the SaaS sales pipeline,
 * where a pumping company already running Jerry is the strongest prospect there
 * is (fb#816). Sent only when true, so the default request is unchanged.
 */
export async function runJerryAdminSearch(client, q, includeJerryActive = false) {
    return toListEnvelope(await client.get(`/api/admin/jerry-companies/search${qs({ q, includeJerryActive: includeJerryActive ? 1 : undefined })}`));
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
// â”€â”€â”€ admin onboarding (provider-acquisition pipeline) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Valid onboarding pipeline status keys — mirrors backend ALL_STATUSES
 * (puminet5api modules/jerryAdmin/onboardingStatus.js): the ranked pipeline
 * first, then the three terminal states. The server 400s on anything else.
 *
 * `ilmoittautunut` is set by the backend when an operator self-applies
 * (source='self_apply'); an operator rarely sets it by hand, but it IS a valid
 * value on every status flag — omitting it here made self-applied prospects
 * look unfilterable/unsettable through the documented vocabulary (fb#377).
 */
export const ONBOARDING_PIPELINE_STATUSES = [
    "ei_aloitettu",
    "ilmoittautunut",
    "email1_lahetetty",
    "muistutus_lahetetty",
    "vastasi_kylla",
    "tiedot_pyydetty",
    "tervetuloa_lahetetty",
];
export const ONBOARDING_TERMINAL_STATUSES = ["vastasi_ei", "ei_vastausta", "ei_sovellu"];
export const ONBOARDING_STATUSES = [
    ...ONBOARDING_PIPELINE_STATUSES,
    ...ONBOARDING_TERMINAL_STATUSES,
];
/** Prose rendering of {@link ONBOARDING_STATUSES} for flag help — single-sourced from the arrays. */
export const ONBOARDING_STATUS_KEYS = `${ONBOARDING_PIPELINE_STATUSES.join(" â†’ ")} (pipeline order; ilmoittautunut is set by self-apply); terminal: ${ONBOARDING_TERMINAL_STATUSES.join(" / ")}`;
/** Prospect company categories — backend COMPANY_TYPES (400 "Unknown companyType"). */
export const COMPANY_TYPES = ["pumppu", "betoni", "all", "owner"];
/** How a prospect entered the pipeline — backend-validated (400 "Invalid source"). */
export const ONBOARDING_SOURCES = ["manual", "import", "scheduled"];
/** Contact-history event kinds — backend-validated (400 "eventType must be call, response or note"). */
export const ONBOARDING_EVENT_TYPES = ["call", "response", "note"];
/**
 * Every event kind that can APPEAR in the trail: the three a caller may write
 * plus the three the backend writes itself (`status_change` on every status
 * move, `email_sent` with the sent-body snapshot, `self_apply` when an operator
 * applies to join Jerry from betonijerry.fi). Read-side only — passing any of
 * the extra three to `onboarding note` is a 400.
 *
 * `self_apply` was missing until fb#690, which made it worse than a docs gap:
 * `--type` is validated against THIS list by `assertEnum`, so the one filter
 * that could isolate inbound applications exited 4 client-side and never
 * reached the backend. Written by `pumppuRequestRoutes.js` `/apply-jerry`,
 * which also reads it back for its 30-minute re-notify throttle.
 */
export const ONBOARDING_EVENT_TYPES_ALL = [
    ...ONBOARDING_EVENT_TYPES,
    "status_change",
    "email_sent",
    "self_apply",
];
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
    const env = toListEnvelope(await client.get(`/api/admin/jerry-onboarding${qs({ status: opts.status || undefined, tier: opts.tier })}`));
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
/**
 * How much of an `email_sent` snapshot the default view keeps. One `email3`
 * body is ~3 KB, so a prospect with three sends buries its own timeline —
 * the same cap-and-hint shape `ib dev feedback list` uses on `description`.
 */
export const ONBOARDING_EVENT_BODY_CAP = 200;
/**
 * Read a prospect's contact history, newest-first
 * (GET /api/admin/jerry-onboarding/:asiakasId/events).
 *
 * The read half of `onboarding note`. The trail is append-only and is where a
 * decision's REASON lives — why a prospect was parked, what the welcome email
 * actually said, when the status last moved and who moved it. None of that is
 * on the prospect row, so without this command a terminal status like
 * `ei_sovellu` cannot be told apart from a deliberate hold without leaving the
 * CLI entirely (fb#391: the route already existed, the command did not).
 *
 * `emailBody` is capped unless `--full`; `truncated` marks a `--limit` cut and
 * `hint` names the body cut, so neither reduction is silent.
 */
export async function runJerryOnboardingEvents(client, asiakasId, opts = {}) {
    const env = toListEnvelope(await client.get(`/api/admin/jerry-onboarding/${asiakasId}/events`));
    let items = env.items;
    if (opts.type)
        items = items.filter((r) => r.eventType === opts.type);
    const cut = typeof opts.limit === "number" && items.length > opts.limit;
    if (cut)
        items = items.slice(0, opts.limit);
    let bodiesCut = 0;
    if (!opts.full) {
        items = items.map((r) => {
            const body = r.emailBody;
            if (typeof body === "string" && body.length > ONBOARDING_EVENT_BODY_CAP) {
                bodiesCut++;
                return { ...r, emailBody: `${body.slice(0, ONBOARDING_EVENT_BODY_CAP)}…` };
            }
            return r;
        });
    }
    return listEnvelope(items, {
        ...(cut ? { truncated: true } : {}),
        ...(bodiesCut > 0
            ? {
                hint: `${bodiesCut} emailBody snapshot(s) cut to ${ONBOARDING_EVENT_BODY_CAP} chars — pass --full for the sent text`,
            }
            : {}),
    });
}
/** Log a call/response/note event (POST /api/admin/jerry-onboarding/:id/events). */
export async function runJerryOnboardingLog(client, asiakasId, body, flags) {
    return client.post(`/api/admin/jerry-onboarding/${asiakasId}/events`, body, { headers: writeFlagsToHeaders(flags) });
}
/**
 * Statuses the admin request list can filter on — mirrors VALID_STATUSES in
 * puminet5api modules/jerryAdmin/jerryAdminRequestsSql.js. Guarded client-side
 * to skip the round-trip; the ROUTE also rejects an unknown status with 400
 * (fb#656, puminet5api@1.29.0). Note the SQL module itself STILL drops unknown
 * statuses silently - the route fences that off, it was not removed - so a
 * direct module caller (e.g. modules/inbox/inboxAggregator.js) is unprotected.
 * Keep the two lists in step: if they drift, one direction makes a valid status
 * unreachable from the CLI, the other turns a local exit 4 into a server 400.
 */
export const ADMIN_REQUEST_STATUSES = [
    "draft",
    "open",
    "no_supply",
    "pending_verification",
    "accepted",
    "cancelled",
    "expired",
];
/** Admin request list (GET /api/admin/jerry-requests). System-admin only. */
export async function runJerryAdminRequests(client, opts) {
    const data = await client.get(`/api/admin/jerry-requests${qs({
        status: opts.status || undefined,
        from: opts.from || undefined,
        to: opts.to || undefined,
        customerId: opts.customer,
        providerId: opts.provider,
        limit: opts.limit,
    })}`);
    return keyedListEnvelope(data, "requests", { truncated: !!data?.truncated });
}
/** Bucket modes for the request rollup. */
export const REQUEST_STATS_GROUPS = ["week", "month", "status"];
/**
 * Windowed tarjouspyyntÃ¶ rollup (GET /api/admin/jerry-requests/stats).
 * System-admin only.
 *
 * The aggregate sibling of `runJerryAdminRequests` (feedback #314): answering
 * "how many per week?" previously meant pulling the whole list and bucketing it
 * client-side, which every caller reimplemented and which silently truncates at
 * the 300-row cap. Counting happens in SQL, in Helsinki time, so the answer does
 * not depend on the caller's timezone or ISO-week arithmetic.
 */
export async function runJerryAdminRequestStats(client, opts) {
    return client.get(`/api/admin/jerry-requests/stats${qs({
        from: opts.from || undefined,
        to: opts.to || undefined,
        groupBy: opts.groupBy || undefined,
    })}`);
}
/** One request's full detail, admin view (GET /api/admin/jerry-requests/:id). System-admin only. */
export async function runJerryAdminRequestGet(client, id) {
    return client.get(`/api/admin/jerry-requests/${id}`);
}
/** Offers on one request, admin view (GET /api/admin/jerry-requests/:id/offers). */
export async function runJerryAdminRequestOffers(client, id) {
    return toListEnvelope(await client.get(`/api/admin/jerry-requests/${id}/offers`));
}
// â”€â”€â”€ admin searches (Osoitehaut: address demand + conversion funnel) â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * Coverage filter for the address-demand list. The backend translates these
 * into a HAVING clause and IGNORES anything else — an unknown value silently
 * returns the unfiltered list, which reads as "every address is covered".
 * Guarded client-side for that reason.
 */
export const SEARCH_DELIVERABLE = ["covered", "no_supply"];
/**
 * Aggregated searched-address demand (GET /api/admin/jerry-searches). System-admin only.
 * Each row is one address (collapsed by place), with searchCount + noSupplyCount — the
 * signal for where to expand provider coverage. --deliverable no_supply isolates the gaps.
 */
export async function runJerryAdminSearches(client, opts) {
    const data = await client.get(`/api/admin/jerry-searches${qs({
        from: opts.from || undefined,
        to: opts.to || undefined,
        deliverable: opts.deliverable || undefined,
        // The backend query param is `q`; the FLAG was renamed to --search (fb#388).
        q: opts.search || opts.q || undefined,
        limit: opts.limit,
    })}`);
    return keyedListEnvelope(data, "rows", { truncated: !!data?.truncated });
}
/**
 * BetoniJerry conversion funnel (GET /api/admin/jerry-searches/funnel). System-admin only.
 * Returns { coverageChecks, wizard: step1..5 + claimed, outcomes } over the date window.
 */
export async function runJerryAdminFunnel(client, opts) {
    return client.get(`/api/admin/jerry-searches/funnel${qs({ from: opts.from || undefined, to: opts.to || undefined })}`);
}
// â”€â”€â”€ admin request write commands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
 * `until` (absolute ISO) when given, else `days` (omitted â†’ backend default 14).
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
/** Parse a tri-state boolean flag value ("true"/"1" â†’ true, else false). */
function parseBool(v) {
    return v === "true" || v === "1";
}
/**
 * Resolve the worksite address from the positional OR the --address flag —
 * {@link resolveDualString} with this command's names.
 */
function resolveAddress(positional, flag) {
    return resolveDualString(positional, flag, "address", "address");
}
/**
 * Register the `ib jerry` command group — the BetoniJerry marketplace surface:
 *   request list/get/offers   read tarjouspyynnÃ¶t + their offers
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
 * Exit codes follow the universal contract via exitWithError (2 auth Â· 3 perm Â·
 * 4 validation Â· 5 not-found Â· 6 server Â· 7 network Â· 1 generic).
 */
export function registerJerryCommands(parent, getClient) {
    const j = parent.command("jerry").description("BetoniJerry marketplace commands");
    // request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const request = j.command("request").description("Pump requests (tarjouspyynnÃ¶t)");
    request
        .command("list")
        .option("--open")
        .option("--mine")
        .option("--status <csv>")
        .option("--limit <n>", "", cappedInt(200))
        .option("--provider")
        .option("--tab <tab>")
        .action(jsonAction(getClient, (client, opts) => runJerryRequestList(client, opts)));
    request
        .command("get <requestId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .option("--provider")
        .action(jsonAction(getClient, (client, idStr, opts) => runJerryRequestGet(client, parseId(idStr, "requestId"), !!opts.provider)));
    request
        .command("offers <requestId>")
        .action(jsonAction(getClient, (client, idStr) => runJerryRequestOffers(client, parseId(idStr, "requestId"))));
    addWriteFlagsToCommand(request
        .command("create [address]")
        .option("--address <s>")
        .requiredOption("--pump-at <iso>")
        .requiredOption("--m3 <n>", "", Number)
        .option("--boom <m>", "", numFlag("--boom"))
        .option("--duration <h>", "", numFlag("--duration"))
        .option("--line-length <m>", "", numFlag("--line-length"))
        .option("--notes <s>")
        .option("--asiakas <id>", "", intFlag("--asiakas"))).action(guarded(async (addressPositional, opts) => {
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
        const client = await getClient();
        writeJson(await runJerryRequestCreate(client, body, opts));
    }));
    // Request-lifecycle leaves (cancel/decline/undecline here, the admin
    // expire/cancel/resend/delete below) are the same registration: one
    // <requestId>, write flags. Only the parent group and the run fn differ.
    const registerRequestAction = (parent, name, run) => {
        addWriteFlagsToCommand(parent.command(`${name} <requestId>`)).action(guarded(async (idStr, opts) => {
            const client = await getClient();
            writeJson(await run(client, parseId(idStr, "requestId"), opts));
        }));
    };
    registerRequestAction(request, "cancel", runJerryRequestCancel);
    // decline is the only member that also sends --reason in the BODY (it is
    // shown to the customer).
    registerRequestAction(request, "decline", (client, id, opts) => runJerryRequestDecline(client, id, opts.reason, opts));
    registerRequestAction(request, "undecline", runJerryRequestUndecline);
    // offer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const offer = j.command("offer").description("Act on offers (create/send/accept/confirm)");
    addWriteFlagsToCommand(offer
        .command("create <requestId>")
        .requiredOption("--price-cents <n>", "", Number)
        .option("--vat-percent <n>", "", numFlag("--vat-percent", 0, 100))
        .option("--price-terms <s>")
        .option("--valid-until <iso>")
        .option("--available-from <iso>")
        .option("--extra-notes <s>")
        .option("--cancellation-terms <s>")
        .option("--maintains-order-info <bool>", "", parseBool)).action(guarded(async (idStr, opts) => {
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
        const client = await getClient();
        writeJson(await runJerryOfferCreate(client, parseId(idStr, "requestId"), body, opts));
    }));
    // send / accept / withdraw / delete are the same registration: two ids, write
    // flags, --reason required. Only the run fn differs. `confirm` is NOT part of
    // the family (extra required options) and keeps its own block, between accept
    // and withdraw so the registration order is unchanged.
    const registerOfferLifecycle = (name, run) => {
        addWriteFlagsToCommand(offer.command(`${name} <requestId> <offerId>`)).action(guarded(async (idStr, offerIdStr, opts) => {
            const client = await getClient();
            writeJson(await run(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
        }));
    };
    registerOfferLifecycle("send", runJerryOfferSend);
    registerOfferLifecycle("accept", runJerryOfferAccept);
    addWriteFlagsToCommand(offer
        .command("confirm <requestId> <offerId>")
        .requiredOption("--scheduled-at <iso>")
        .option("--pumppu <vehicleId>", "", intFlag("--pumppu", 1))).action(guarded(async (idStr, offerIdStr, opts) => {
        const body = { scheduledAt: opts.scheduledAt };
        if (opts.pumppu !== undefined)
            body.pumppuId = opts.pumppu;
        const client = await getClient();
        writeJson(await runJerryOfferConfirm(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), body, opts));
    }));
    registerOfferLifecycle("withdraw", runJerryOfferWithdraw);
    registerOfferLifecycle("delete", runJerryOfferDelete);
    // counts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    j.command("counts")
        .option("--provider")
        .option("--mine")
        .action(jsonAction(getClient, (client, opts) => runJerryCounts(client, !!opts.provider)));
    // stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    j.command("stats")
        .option("--weeks <n>", "", intFlag("--weeks", 1))
        .action(jsonAction(getClient, (client, opts) => runJerryStats(client, opts.weeks)));
    // check-address â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    j.command("check-address")
        .requiredOption("--address <s>")
        .option("--lat <n>", "", numFlag("--lat"))
        .option("--lng <n>", "", numFlag("--lng"))
        .option("--place-id <s>")
        .option("--formatted-address <s>")
        .option("--boom <m>", "", Number)
        .option("--explain")
        .option("--gate <csv>", "", (v) => v.split(",").map((g) => g.trim()).filter(Boolean))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .action(guarded(async (opts) => {
        // Reject a NaN --boom (e.g. Commander coercing "abc" â†’ NaN) so the probe
        // fails loudly instead of silently dropping the boom filter the operator
        // asked for — misleading during onboarding verification.
        if (opts.boom !== undefined && (!Number.isFinite(opts.boom) || opts.boom < 0)) {
            failWith("--boom must be a non-negative number of metres", 4);
        }
        // --asiakas only makes sense alongside --explain (it scopes the considered[]
        // universe); reject a positive id without --explain so the operator isn't
        // silently ignored, and reject a non-positive-integer id like other targets.
        if (opts.asiakas !== undefined) {
            assertPositiveInt(opts.asiakas, "--asiakas");
            if (!opts.explain) {
                failWith("--asiakas only applies with --explain", 4);
            }
        }
        if (opts.gate?.length) {
            if (!opts.explain) {
                failWith("--gate only applies with --explain", 4);
            }
            // Reject an unknown gate here rather than letting the server drop it —
            // a silently-narrowed diagnostic reads as "nothing else is wrong".
            assertEnumCsv(opts.gate, CHECK_ADDRESS_GATES, "--gate");
        }
        const client = await getClient();
        writeJson(await runJerryCheckAddress(client, opts));
    }));
    // coverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    j.command("coverage")
        .action(jsonAction(getClient, runJerryCoverage));
    // email-activity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    j.command("email-activity")
        .option("--days <n>", "", (v) => Math.min(90, intFlag("--days", 1)(v)))
        .option("--domain <d>")
        .action(jsonAction(getClient, (client, opts) => runJerryEmailActivity(client, opts)));
    // provider-settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ps = j
        .command("provider-settings")
        .description("Per-provider BetoniJerry settings (contact, opening hours, description)");
    ps.command("get")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .action(jsonAction(getClient, (client, opts) => runJerryProviderSettingsGet(client, opts.asiakas)));
    addWriteFlagsToCommand(ps
        .command("set")
        .option("--body <json>")
        .option("--from-json <file>")
        // `--email`, not `--offer-email`: the latter is a near-spelling of the
        // established `--offer` (a pumppuOfferId on 5 commands) and reads as "the
        // email of offer N" — flag-vocabulary.test.ts rejects it. `--email` is the
        // majority spelling and unambiguous here, since this is the only address
        // the command sets (same shape as `ib customer update --email`).
        .option("--email <email>")
        .option("--asiakas <id>", "", intFlag("--asiakas"))).action(guarded(async (opts) => {
        const parsed = resolveJsonObjectBody({ body: opts.body, fromJson: opts.fromJson });
        if (!parsed && opts.email === undefined) {
            failWith("provider-settings set requires a body via --body, --from-json or --email", 4);
        }
        // getClient AFTER the guard so a usage error exits 4, not 2 ("Not logged
        // in") — matches `worksite update` / `person update`.
        const client = await getClient();
        writeJson(await runJerryProviderSettingsSet(client, buildJerryProviderSettingsBody(parsed, opts), opts.asiakas, opts));
    }));
    // admin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const admin = j
        .command("admin")
        .description("System-admin Jerry dashboard (enable/disable + listings)");
    admin
        .command("list")
        .option("--with-notification")
        .action(jsonAction(getClient, (client, opts) => runJerryAdminList(client, opts.withNotification ?? false)));
    admin
        .command("search [query]")
        .option("--search <s>")
        .option("--include-jerry-active", "also return companies that already have Jerry (fb#816)")
        .addOption(queryAliasOption())
        .action(jsonAction(getClient, (client, query, opts) => runJerryAdminSearch(client, resolveSearchQuery(query, opts.search, opts.query), opts.includeJerryActive ?? false)));
    addAsiakasTargetOption(admin.command("detail [asiakasId]")).action(jsonAction(getClient, (client, idStr, opts) => runJerryAdminDetail(client, resolveAsiakasTarget(idStr, opts.asiakas))));
    for (const [name, enable] of [
        ["enable", true],
        ["disable", false],
    ]) {
        addWriteFlagsToCommand(addAsiakasTargetOption(admin.command(`${name} [asiakasId]`))).action(guarded(async (idStr, opts) => {
            const client = await getClient();
            writeJson(await runJerryAdminToggle(client, resolveAsiakasTarget(idStr, opts.asiakas), enable, opts));
        }));
    }
    // admin onboarding — provider-acquisition pipeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const onboarding = admin
        .command("onboarding")
        .description("Provider onboarding pipeline (prospects + contact history)");
    onboarding
        .command("list")
        .option("--status <key>")
        .option("--tier <n>", "", intFlag("--tier", 1))
        .option("--due")
        .option("--search <text>")
        .action(jsonAction(getClient, (client, opts) => runJerryOnboardingList(client, opts)));
    // Option-name → body-key map (only `notes` renames, to `muistiinpanot`);
    // entry order is the emitted key order.
    const PROSPECT_FIELDS = {
        tier: "tier",
        malli: "malli",
        kanava: "kanava",
        alue: "alue",
        status: "status",
        notes: "muistiinpanot",
        outreachName: "outreachName",
        outreachEmail: "outreachEmail",
        outreachPhone: "outreachPhone",
        companyType: "companyType",
        parkedUntil: "parkedUntil",
    };
    const pickProspectFields = (o) => {
        const out = {};
        for (const [opt, key] of Object.entries(PROSPECT_FIELDS)) {
            if (o[opt] !== undefined)
                out[key] = o[opt];
        }
        return out;
    };
    addWriteFlagsToCommand(onboarding
        .command("add <asiakasId>")
        .option("--tier <n>", "", intFlag("--tier", 1))
        .option("--malli <v>")
        .option("--kanava <text>")
        .option("--alue <text>")
        .option("--company-type <t>")
        .option("--source <s>")).action(jsonAction(getClient, (client, idStr, opts) => runJerryOnboardingAdd(client, resolveAsiakasTarget(idStr, undefined), { ...pickProspectFields(opts), ...(opts.source !== undefined ? { source: opts.source } : {}) }, opts)));
    addWriteFlagsToCommand(onboarding
        .command("set <asiakasId>")
        .option("--status <key>")
        .option("--tier <n>", "", intFlag("--tier", 1))
        .option("--malli <v>")
        .option("--kanava <text>")
        .option("--alue <text>")
        .option("--company-type <t>")
        .option("--notes <text>")
        .option("--outreach-name <text>")
        .option("--outreach-email <email>")
        .option("--outreach-phone <phone>")
        .option("--parked-until <date>", "", resolveDate)).action(jsonAction(getClient, (client, idStr, opts) => runJerryOnboardingSet(client, resolveAsiakasTarget(idStr, undefined), pickProspectFields(opts), opts)));
    onboarding
        .command("events <asiakasId>")
        .option("--type <t>")
        .option("--limit <n>", "", cappedInt(200))
        .option("--full")
        .action(guarded(async (idStr, opts) => {
        if (opts.type)
            assertEnum(opts.type, ONBOARDING_EVENT_TYPES_ALL, "--type");
        const client = await getClient();
        writeJson(await runJerryOnboardingEvents(client, resolveAsiakasTarget(idStr, undefined), opts));
    }));
    // Canonical writer is `note`; `log` stays as a hidden, still-executable alias.
    // Every other `ib … log` in this CLI is an audit-trail READ (`ib person log`,
    // `ib log latest/range/by-entity-date`), so the old name actively mispointed
    // callers looking for the history — the read now lives at `events` (fb#391).
    const onboardingNoteAction = guarded(async (idStr, opts) => {
        const client = await getClient();
        const body = { eventType: opts.type, eventText: opts.text };
        if (opts.time !== undefined)
            body.eventTime = opts.time;
        if (opts.setStatus !== undefined)
            body.setStatus = opts.setStatus;
        writeJson(await runJerryOnboardingLog(client, resolveAsiakasTarget(idStr, undefined), body, opts));
    });
    const addNoteOptions = (cmd) => cmd
        .requiredOption("--type <t>")
        .requiredOption("--text <text>")
        // Normalized at PARSE time so both `note` and its hidden `log` alias get
        // it: offset-less input is Helsinki wall-clock, zoned input is converted
        // to the real UTC instant. Posting the raw string let the DATETIME2 bind
        // drop the offset — 12:00+03:00 stored as 12:00Z, silently (fb#412).
        .option("--time <iso>", "", (v) => resolveDateTime(v))
        .option("--set-status <key>");
    addWriteFlagsToCommand(addNoteOptions(onboarding.command("note <asiakasId>"))).action(onboardingNoteAction);
    addWriteFlagsToCommand(addNoteOptions(onboarding.command("log <asiakasId>", { hidden: true })).description("Deprecated alias for `ib jerry admin onboarding note` (still works). To READ the history, use `ib jerry admin onboarding events`.")).action(onboardingNoteAction);
    // admin request — lifecycle subgroup (reads + write transitions) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const adminRequest = admin
        .command("request")
        .description("Admin tarjouspyyntÃ¶ lifecycle (list/get/offers/expire/cancel/resend/extend/delete)");
    adminRequest
        .command("list")
        .option("--status <csv>")
        .option("--from <date>", "", resolveDate)
        .option("--to <date>", "", resolveDate)
        // intFlag, not a bare Number: a NaN id is NOT dropped by qs() (only
        // `undefined` is), so `--customer abc` used to put `customerId=NaN` on the
        // wire, where it 500'd on bind until fb#656 turned it into a 400. Either
        // way the CLI should answer that locally - the fb#249 shape.
        .option("--customer <id>", "", intFlag("--customer", 1))
        .option("--provider <id>", "", intFlag("--provider", 1))
        .option("--limit <n>", "", cappedInt(300))
        .action(guarded(async (opts) => {
        // Guarded here to skip the round-trip; see ADMIN_REQUEST_STATUSES.
        // `confirmed` is the word `ib jerry offer confirm` teaches, but the
        // request status is `accepted` — a hint, never a rewrite (fb#1310).
        if (opts.status) {
            assertEnumCsv(opts.status.split(",").map((s) => s.trim()).filter(Boolean), ADMIN_REQUEST_STATUSES, "--status", { confirmed: "accepted" });
        }
        const client = await getClient();
        writeJson(await runJerryAdminRequests(client, opts));
    }));
    adminRequest
        .command("stats")
        .option("--from <date>", "", resolveDate)
        .option("--to <date>", "", resolveDate)
        .option("--group-by <mode>")
        .action(guarded(async (opts) => {
        // Guarded here to skip the round-trip; the ROUTE rejects an unknown mode
        // with 400 too. The SQL module still defaults to `week` on anything it
        // does not recognise (getRequestStats), so that silent-default hazard is
        // real for a direct module caller — the route fences it off, exactly as
        // it does for --status. Same shape as ADMIN_REQUEST_STATUSES above.
        assertEnum(opts.groupBy, REQUEST_STATS_GROUPS, "--group-by");
        const client = await getClient();
        writeJson(await runJerryAdminRequestStats(client, opts));
    }));
    adminRequest
        .command("get <requestId>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .action(jsonAction(getClient, (client, idStr) => runJerryAdminRequestGet(client, parseId(idStr, "requestId"))));
    adminRequest
        .command("offers <requestId>")
        .action(jsonAction(getClient, (client, idStr) => runJerryAdminRequestOffers(client, parseId(idStr, "requestId"))));
    registerRequestAction(adminRequest, "expire", runJerryAdminRequestExpire);
    registerRequestAction(adminRequest, "cancel", runJerryAdminRequestCancel);
    registerRequestAction(adminRequest, "resend", runJerryAdminRequestResend);
    registerRequestAction(adminRequest, "delete", runJerryAdminRequestDelete);
    // extend needs --days/--until, so it is registered outside adminReqAction.
    addWriteFlagsToCommand(adminRequest
        .command("extend <requestId>")
        .option("--days <n>", "", Number)
        .option("--until <date>")).action(guarded(async (idStr, opts) => {
        if (opts.days != null && opts.until)
            failWith("Pass either --days or --until, not both", 4);
        const client = await getClient();
        writeJson(await runJerryAdminRequestExtend(client, parseId(idStr, "requestId"), opts));
    }));
    // admin searches — Osoitehaut: address demand + conversion funnel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const adminSearches = admin
        .command("searches")
        .description("Address-search demand + wizard conversion funnel (Osoitehaut)");
    adminSearches
        .command("list")
        .option("--from <date>", "", resolveDate)
        .option("--to <date>", "", resolveDate)
        .option("--deliverable <k>")
        .option("--search <text>")
        // Back-compat alias for the pre-rename spelling (fb#388). `--q` was the lone
        // outlier among 20 search commands — 19 spell it `--search` — and guessing
        // the majority form did not merely fail here, it redirected the caller to
        // `ib jerry admin search`, a DIFFERENT command (coverage check, not demand).
        // Hidden: the spec documents only `--search`.
        .addOption(new Option("--q <text>").hideHelp())
        .option("--limit <n>", "", cappedInt(500))
        .action(guarded(async (opts) => {
        // An unknown --deliverable is ignored server-side (no HAVING clause), so
        // the caller gets the UNFILTERED list — "no_suply" would read as "every
        // address we ever checked is covered".
        assertEnum(opts.deliverable, SEARCH_DELIVERABLE, "--deliverable");
        const client = await getClient();
        writeJson(await runJerryAdminSearches(client, opts));
    }));
    adminSearches
        .command("funnel")
        .option("--from <date>", "", resolveDate)
        .option("--to <date>", "", resolveDate)
        .action(jsonAction(getClient, (client, opts) => runJerryAdminFunnel(client, opts)));
}
//# sourceMappingURL=index.js.map