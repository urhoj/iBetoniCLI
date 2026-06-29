import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { parseJsonBodyFlag } from "../../api/parseBody.js";
import { resolveAsiakasTarget } from "../customer/index.js";
import { parseId } from "../../targets.js";
import { resolveDate } from "../../dates.js";

type Row = Record<string, unknown>;

/**
 * Wrap a backend array into the universal `{ items, nextCursor, count }` list
 * envelope. The BetoniJerry endpoints return bare arrays (sendSuccess sends raw
 * data), so the CLI projects them client-side — the established pattern for
 * reads that reuse non-`/api/cli/` routes. Defensive against a non-array body.
 */
function toEnvelope(value: unknown): ListEnvelope<Row> {
  const items = Array.isArray(value) ? (value as Row[]) : [];
  return { items, nextCursor: null, count: items.length };
}

// ─── request reads ──────────────────────────────────────────────────────────

export interface JerryRequestListOpts {
  open?: boolean;
  mine?: boolean;
  status?: string;
  limit?: number;
  all?: boolean;
  provider?: boolean;
  tab?: string;
}

/**
 * List pump requests (tarjouspyynnöt). Two views:
 *   --open  → GET /api/pumppuRequests/open       (provider inbox; isProvider; PII masked until your offer is accepted)
 *   --mine  → GET /api/pumppuRequests/mine        (the caller's own requests; default)
 * `--status` (CSV) and `--limit` apply to the --mine view only. Projected into
 * the universal list envelope.
 */
export async function runJerryRequestList(
  client: ApiClient,
  opts: JerryRequestListOpts
): Promise<ListEnvelope<Row>> {
  if (opts.provider) {
    const tab = opts.tab || "avoimet";
    const data = await client.get<{ requests?: unknown }>(
      `/api/pumppuRequests/provider-list?tab=${encodeURIComponent(tab)}`
    );
    const items = Array.isArray(data?.requests) ? (data.requests as Row[]) : [];
    return { items, nextCursor: null, count: items.length };
  }
  if (opts.open) {
    if (opts.all) {
      // Whole-marketplace browse (?scope=all): open + no_supply beyond the
      // caller's varikko delivery area, with distanceKm/isOutOfArea/isNoSupply.
      // The backend returns { requests, truncated } so the 200-row cap is exact,
      // not inferred from length.
      const data = await client.get<{ requests?: unknown; truncated?: boolean }>(
        "/api/pumppuRequests/open?scope=all"
      );
      const items = Array.isArray(data?.requests) ? (data.requests as Row[]) : [];
      return { items, nextCursor: null, count: items.length, truncated: !!data?.truncated };
    }
    return toEnvelope(await client.get<unknown>("/api/pumppuRequests/open"));
  }
  // --all only narrows the provider inbox; --mine has no whole-marketplace scope.
  if (opts.all) {
    failWith("--all only applies with --open (whole-marketplace browse)", 4);
  }
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return toEnvelope(
    await client.get<unknown>(`/api/pumppuRequests/mine${qs ? `?${qs}` : ""}`)
  );
}

/**
 * Get a single pump request. Default is the customer-owned recap
 * (GET /api/pumppuRequests/:id). `--provider` switches to the provider-facing
 * detail (GET /api/pumppuRequests/:id/provider-detail; requires isProvider) —
 * customer PII stays masked there until this provider's offer is accepted.
 */
export async function runJerryRequestGet(
  client: ApiClient,
  id: number,
  asProvider: boolean
): Promise<Row> {
  const path = asProvider
    ? `/api/pumppuRequests/${id}/provider-detail`
    : `/api/pumppuRequests/${id}`;
  return client.get<Row>(path);
}

/**
 * List the offers on a customer-owned request (GET /api/pumppuRequests/:id/offers).
 * Provider contact fields (jerryContactName/Phone, openingHours) are revealed
 * only on the accepted offer row. Projected into the list envelope.
 */
export async function runJerryRequestOffers(
  client: ApiClient,
  id: number
): Promise<ListEnvelope<Row>> {
  return toEnvelope(
    await client.get<unknown>(`/api/pumppuRequests/${id}/offers`)
  );
}

// ─── offer writes ─────────────────────────────────────────────────────────────

export interface JerryOfferCreateBody {
  priceCents: number;
  vatPercent?: number;
  priceTerms?: string;
  validUntil?: string;
  availableFrom?: string;
  extraNotes?: string;
  cancellationTerms?: string;
  maintainsOrderInfo?: boolean;
}

/**
 * Create or update (upsert) the caller's offer on a request
 * (POST /api/pumppuRequests/:id/offers). Provider-only. A new offer starts as
 * 'draft' (invisible to the customer) — transition it with `offer send`.
 * Re-running while still draft/pending edits the existing offer.
 */
export async function runJerryOfferCreate(
  client: ApiClient,
  id: number,
  body: JerryOfferCreateBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/pumppuRequests/${id}/offers`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Send a draft offer (draft → pending; POST /:id/offers/:offerId/send) — makes
 * it visible to the customer. Provider-only; you must own the offer.
 */
export async function runJerryOfferSend(
  client: ApiClient,
  id: number,
  offerId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    `/api/pumppuRequests/${id}/offers/${offerId}/send`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Withdraw your sent offer before the customer accepts it
 * (pending → withdrawn; POST /:id/offers/:offerId/withdraw). Provider-only; own offer.
 */
export async function runJerryOfferWithdraw(
  client: ApiClient,
  id: number,
  offerId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    `/api/pumppuRequests/${id}/offers/${offerId}/withdraw`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Hard-delete your OWN DRAFT offer (DELETE /:id/offers/:offerId). Provider-only;
 * own offer; DRAFT status only — a sent offer 409s (use `offer withdraw` for
 * pending). Mirrors the request-draft delete; the offer's attachments are
 * soft-deleted server-side. Returns { success, pumppuOfferId, deleted } (or the
 * dry-run wouldDelete echo).
 */
export async function runJerryOfferDelete(
  client: ApiClient,
  id: number,
  offerId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete<unknown>(`/api/pumppuRequests/${id}/offers/${offerId}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Accept an offer (customer-side; POST /:id/offers/:offerId/accept). Flips this
 * offer to 'accepted', sibling offers to 'rejected', and the request to
 * 'accepted'. Caller must own the request.
 */
export async function runJerryOfferAccept(
  client: ApiClient,
  id: number,
  offerId: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    `/api/pumppuRequests/${id}/offers/${offerId}/accept`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Confirm an accepted offer (provider-side; POST /:id/offers/:offerId/confirm).
 * Heavyweight: builds a keikka in the provider's grid. `scheduledAt` (future
 * ISO) is required; `pumppuId` optionally pins one of your vehicles.
 */
export async function runJerryOfferConfirm(
  client: ApiClient,
  id: number,
  offerId: number,
  body: { scheduledAt: string; pumppuId?: number },
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    `/api/pumppuRequests/${id}/offers/${offerId}/confirm`,
    body,
    { headers: writeFlagsToHeaders(flags) }
  );
}

// ─── request write (customer tarjouspyyntö) ─────────────────────────────────

export interface JerryRequestCreateBody {
  osoite: string;
  pumppausaika: string;
  maaraM3: number;
  puomi?: number;
  kesto?: number;
  linjanPituus?: number;
  kuvaus?: string;
  asiakasId?: number;
}

/**
 * Cancel the caller's OWN request (customer-side; POST /api/pumppuRequests/:id/cancel).
 * Allowed only while no live offer exists (server enforces). Sets status 'cancelled'.
 */
export async function runJerryRequestCancel(
  client: ApiClient,
  id: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(`/api/pumppuRequests/${id}/cancel`, {}, {
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
export async function runJerryRequestCreate(
  client: ApiClient,
  body: JerryRequestCreateBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/pumppuRequests", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * Lifecycle counts. Default is the customer view (GET /api/pumppuRequests/mine/counts:
 * draft/open/pending_verification/accepted/cancelled/expired/no_supply).
 * `--provider` returns the provider badge counts (GET /api/pumppuRequests/provider-counts:
 * avoimet/tarjotut/voitetut/voitetutActionRequired/paattyneet; requires isProvider).
 */
export async function runJerryCounts(
  client: ApiClient,
  provider: boolean
): Promise<Row> {
  const path = provider
    ? "/api/pumppuRequests/provider-counts"
    : "/api/pumppuRequests/mine/counts";
  return client.get<Row>(path);
}

export interface JerryCheckAddressOpts {
  address: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  formattedAddress?: string;
}

/**
 * Anonymous geofence feasibility probe (POST /api/pumppuRequests/checkAddress).
 * Answers "does any provider varikko cover this address?" — the root-cause tool
 * for "no offers". `--address` maps to the required `osoite` body field; if
 * `--lat`/`--lng`/`--place-id` are all supplied the server trusts them instead
 * of re-geocoding. Not a mutation, so no write-safety flags. The `providers`
 * array is only present when the caller's token is a developer/admin.
 */
export async function runJerryCheckAddress(
  client: ApiClient,
  opts: JerryCheckAddressOpts
): Promise<Row> {
  const body: Row = { osoite: opts.address };
  if (opts.lat !== undefined) body.lat = opts.lat;
  if (opts.lng !== undefined) body.lng = opts.lng;
  if (opts.placeId) body.placeId = opts.placeId;
  if (opts.formattedAddress) body.formattedAddress = opts.formattedAddress;
  return client.post<Row>("/api/pumppuRequests/checkAddress", body, { read: true });
}

// ─── provider settings ──────────────────────────────────────────────────────

/**
 * Read a provider company's BetoniJerry settings (GET /api/jerry-provider-settings).
 * Defaults to the caller's own company; `--asiakas` targets another company the
 * caller has edit rights on.
 */
export async function runJerryProviderSettingsGet(
  client: ApiClient,
  asiakasId?: number
): Promise<Row> {
  const qs = asiakasId !== undefined ? `?asiakasId=${asiakasId}` : "";
  return client.get<Row>(`/api/jerry-provider-settings${qs}`);
}

/**
 * Upsert a provider company's BetoniJerry settings (PUT /api/jerry-provider-settings).
 * Partial-payload-safe: only the body keys present are written. `--asiakas` is
 * merged into the body to target a specific company. Write flags surface as the
 * universal headers.
 */
export async function runJerryProviderSettingsSet(
  client: ApiClient,
  body: Row,
  asiakasId: number | undefined,
  flags: WriteFlags
): Promise<unknown> {
  const payload = asiakasId !== undefined ? { ...body, asiakasId } : body;
  return client.put<unknown>("/api/jerry-provider-settings", payload, {
    headers: writeFlagsToHeaders(flags),
  });
}

// ─── admin (system-admin Jerry dashboard) ───────────────────────────────────

/** List Jerry-active companies with per-company counts (GET /api/admin/jerry-companies). System-admin only. */
export async function runJerryAdminList(
  client: ApiClient
): Promise<ListEnvelope<Row>> {
  return toEnvelope(await client.get<unknown>("/api/admin/jerry-companies"));
}

/** Search non-Jerry companies for the Add picker (GET /api/admin/jerry-companies/search?q=). System-admin only. */
export async function runJerryAdminSearch(
  client: ApiClient,
  q: string
): Promise<ListEnvelope<Row>> {
  return toEnvelope(
    await client.get<unknown>(
      `/api/admin/jerry-companies/search?q=${encodeURIComponent(q)}`
    )
  );
}

/** Company drill-down: people by role, vehicles, sijainnit Jerry status (GET /api/admin/jerry-companies/:id/detail). System-admin only. */
export async function runJerryAdminDetail(
  client: ApiClient,
  asiakasId: number
): Promise<Row> {
  return client.get<Row>(`/api/admin/jerry-companies/${asiakasId}/detail`);
}

/**
 * Enable (`on=true`) or disable (`on=false`) the Jerry module for a company —
 * the audited toggle that sets both isPumppuToimittaja and the HAS_JERRY
 * setting (POST /api/admin/jerry-companies/:id/{enable,disable}). System-admin
 * only. Write flags surface as headers.
 */
export async function runJerryAdminToggle(
  client: ApiClient,
  asiakasId: number,
  on: boolean,
  flags: WriteFlags
): Promise<unknown> {
  const action = on ? "enable" : "disable";
  return client.post<unknown>(
    `/api/admin/jerry-companies/${asiakasId}/${action}`,
    {},
    { headers: writeFlagsToHeaders(flags) }
  );
}

export interface JerryAdminRequestsOpts {
  status?: string;
  from?: string;
  to?: string;
  customer?: number;
  provider?: number;
  limit?: number;
}

/** Admin request list (GET /api/admin/jerry-requests). System-admin only. */
export async function runJerryAdminRequests(
  client: ApiClient,
  opts: JerryAdminRequestsOpts
): Promise<ListEnvelope<Row>> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.customer !== undefined) params.set("customerId", String(opts.customer));
  if (opts.provider !== undefined) params.set("providerId", String(opts.provider));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const data = await client.get<{ requests?: unknown; truncated?: boolean }>(
    `/api/admin/jerry-requests${qs ? `?${qs}` : ""}`
  );
  const items = Array.isArray(data?.requests) ? (data.requests as Row[]) : [];
  return { items, nextCursor: null, count: items.length, truncated: !!data?.truncated };
}

/** One request's full detail, admin view (GET /api/admin/jerry-requests/:id). System-admin only. */
export async function runJerryAdminRequestGet(
  client: ApiClient,
  id: number
): Promise<Row> {
  return client.get<Row>(`/api/admin/jerry-requests/${id}`);
}

/** Offers on one request, admin view (GET /api/admin/jerry-requests/:id/offers). */
export async function runJerryAdminRequestOffers(
  client: ApiClient,
  id: number
): Promise<ListEnvelope<Row>> {
  return toEnvelope(await client.get<unknown>(`/api/admin/jerry-requests/${id}/offers`));
}

// ─── admin request write commands ────────────────────────────────────────────

/**
 * Factory for admin request status-transition commands (expire/cancel/resend).
 * POSTs to /api/admin/jerry-requests/:id/:action with write-safety headers.
 */
const adminReqWrite = (action: string) =>
  (client: ApiClient, id: number, flags: WriteFlags): Promise<unknown> =>
    client.post<unknown>(`/api/admin/jerry-requests/${id}/${action}`, {}, { headers: writeFlagsToHeaders(flags) });

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
export async function runJerryAdminRequestExtend(
  client: ApiClient,
  id: number,
  opts: { days?: number; until?: string } & WriteFlags
): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (opts.until) body.until = opts.until;
  else if (opts.days != null) body.days = opts.days;
  return client.post<unknown>(`/api/admin/jerry-requests/${id}/extend`, body, {
    headers: writeFlagsToHeaders(opts),
  });
}

/** Delete a draft request (admin; DELETE /api/admin/jerry-requests/:id). System-admin only. */
export async function runJerryAdminRequestDelete(
  client: ApiClient,
  id: number,
  flags: WriteFlags
): Promise<unknown> {
  return client.delete<unknown>(`/api/admin/jerry-requests/${id}`, { headers: writeFlagsToHeaders(flags) });
}

// ─── registration ────────────────────────────────────────────────────────────

type WriteOpts = WriteFlags;

/** Enforce a required --reason at the CLI layer (exit 4), matching the lifecycle commands. */
function requireReason(opts: WriteOpts): void {
  if (!opts.reason) {
    failWith("Missing required flag: --reason", 4);
  }
}

/** Parse a tri-state boolean flag value ("true"/"1" → true, else false). */
function parseBool(v: string): boolean {
  return v === "true" || v === "1";
}

/**
 * Resolve the worksite address from the positional OR the --address flag.
 * Exactly one is required; both are allowed only if they agree. (resolveTarget
 * is integer-only, so the dual-input is handled inline for this string field.)
 */
function resolveAddress(positional: string | undefined, flag: string | undefined): string {
  const p = positional?.trim();
  const f = flag?.trim();
  if (p && f) {
    if (p !== f) failWith("Address given twice and they differ (positional vs --address)", 4);
    return p;
  }
  const v = p || f;
  if (!v) failWith("Missing required address (positional <address> or --address)", 4);
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
export function registerJerryCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const j = parent.command("jerry").description("BetoniJerry marketplace commands");

  // request ──────────────────────────────────────────────────────────────────
  const request = j.command("request").description("Pump requests (tarjouspyynnöt)");

  request
    .command("list")
    .description("List pump requests (--mine default, or --open provider inbox)")
    .option("--open", "Provider inbox: open requests (requires provider role)")
    .option("--all", "With --open: browse the whole marketplace — open/no_supply requests beyond your varikko delivery area (adds distanceKm/isOutOfArea/isNoSupply)")
    .option("--mine", "Your own requests (default)")
    .option("--status <csv>", "Filter --mine by status (CSV)")
    .option("--limit <n>", "Max rows for --mine", (v: string) => Math.min(Number(v), 200))
    .option("--provider", "Provider lifecycle view via /provider-list (incl. your sent offers)")
    .option("--tab <tab>", "With --provider: avoimet|tarjotut|voitetut|paattyneet|kokomarkkina (default avoimet)")
    .action(async (opts: JerryRequestListOpts) => {
      try {
        const client = await getClient();
        writeJson(await runJerryRequestList(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  request
    .command("get <requestId>")
    .description("Get a single pump request (--provider for the provider-facing detail)")
    .option("--provider", "Use the provider-facing detail view (requires provider role)")
    .action(async (idStr: string, opts: { provider?: boolean }) => {
      try {
        const client = await getClient();
        writeJson(await runJerryRequestGet(client, parseId(idStr, "requestId"), !!opts.provider));
      } catch (e) {
        exitWithError(e);
      }
    });

  request
    .command("offers <requestId>")
    .description("List the offers on a customer-owned request")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        writeJson(await runJerryRequestOffers(client, parseId(idStr, "requestId")));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    request
      .command("create [address]")
      .description(
        "Create a customer pump request (tarjouspyyntö). Address positional or --address. Requires --reason. ⚠ --dry-run is deploy-gated."
      )
      .option("--address <s>", "Worksite address (osoite); alias for the positional")
      .requiredOption("--pump-at <iso>", "Pump datetime (pumppausaika; ISO, e.g. 2026-06-17T09:00:00+03:00)")
      .requiredOption("--m3 <n>", "Concrete volume m³ (maaraM3; > 0)", Number)
      .option("--boom <m>", "Required boom reach m (puomi; default 0)", Number)
      .option("--duration <h>", "Pump duration hours (kesto)", Number)
      .option("--line-length <m>", "Hose line length m (linjanPituus)", Number)
      .option("--notes <s>", "Free-text description shown to providers (kuvaus)")
      .option("--asiakas <id>", "Customer asiakasId (omit → your private BetoniJerry account)", Number)
  ).action(
    async (
      addressPositional: string | undefined,
      opts: WriteOpts & {
        address?: string;
        pumpAt: string;
        m3: number;
        boom?: number;
        duration?: number;
        lineLength?: number;
        notes?: string;
        asiakas?: number;
      }
    ) => {
      requireReason(opts);
      const osoite = resolveAddress(addressPositional, opts.address);
      const maaraM3 = Number(opts.m3);
      if (!Number.isFinite(maaraM3) || maaraM3 <= 0) {
        failWith("--m3 must be a number > 0", 4);
      }
      const body: JerryRequestCreateBody = { osoite, pumppausaika: opts.pumpAt, maaraM3 };
      if (opts.boom !== undefined) body.puomi = opts.boom;
      if (opts.duration !== undefined) body.kesto = opts.duration;
      if (opts.lineLength !== undefined) body.linjanPituus = opts.lineLength;
      if (opts.notes) body.kuvaus = opts.notes;
      if (opts.asiakas !== undefined) body.asiakasId = opts.asiakas;
      try {
        const client = await getClient();
        writeJson(await runJerryRequestCreate(client, body, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    request
      .command("cancel <requestId>")
      .description("Cancel your OWN request (customer) — only while no offers received. Requires --reason.")
  ).action(async (idStr: string, opts: WriteOpts) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryRequestCancel(client, parseId(idStr, "requestId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  // offer ──────────────────────────────────────────────────────────────────────
  const offer = j.command("offer").description("Act on offers (create/send/accept/confirm)");

  addWriteFlagsToCommand(
    offer
      .command("create <requestId>")
      .description("Create/update your draft offer on a request (provider). Requires --reason.")
      .requiredOption("--price-cents <n>", "Offer price in cents (integer 1..99999900)", Number)
      .option("--vat-percent <n>", "VAT percent (default 25.5)", Number)
      .option("--price-terms <s>", "Price-estimate terms (Hinta-arvion ehdot) shown to the customer")
      .option("--valid-until <iso>", "Offer valid-until (ISO datetime)")
      .option("--available-from <iso>", "Earliest availability (ISO datetime; stored, not shown on the BetoniJerry customer card)")
      .option("--extra-notes <s>", "Free-text notes shown to the customer")
      .option("--cancellation-terms <s>", "Per-offer cancellation terms (stored; BetoniJerry shows a platform-standard peruutusehdot, so this is NOT rendered on the customer card)")
      .option("--maintains-order-info <bool>", "Override provider default (true|false)", parseBool)
  ).action(
    async (
      idStr: string,
      opts: WriteOpts & {
        priceCents: number;
        vatPercent?: number;
        priceTerms?: string;
        validUntil?: string;
        availableFrom?: string;
        extraNotes?: string;
        cancellationTerms?: string;
        maintainsOrderInfo?: boolean;
      }
    ) => {
      requireReason(opts);
      const priceCents = Number(opts.priceCents);
      if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99_999_900) {
        failWith("--price-cents must be an integer in 1..99999900", 4);
      }
      const body: JerryOfferCreateBody = { priceCents };
      if (opts.vatPercent !== undefined) body.vatPercent = opts.vatPercent;
      if (opts.priceTerms) body.priceTerms = opts.priceTerms;
      if (opts.validUntil) body.validUntil = opts.validUntil;
      if (opts.availableFrom) body.availableFrom = opts.availableFrom;
      if (opts.extraNotes) body.extraNotes = opts.extraNotes;
      if (opts.cancellationTerms) body.cancellationTerms = opts.cancellationTerms;
      if (opts.maintainsOrderInfo !== undefined) body.maintainsOrderInfo = opts.maintainsOrderInfo;
      try {
        const client = await getClient();
        writeJson(await runJerryOfferCreate(client, parseId(idStr, "requestId"), body, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    offer
      .command("send <requestId> <offerId>")
      .description("Send a draft offer to the customer (draft → pending; provider). Requires --reason.")
  ).action(async (idStr: string, offerIdStr: string, opts: WriteOpts) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryOfferSend(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    offer
      .command("accept <requestId> <offerId>")
      .description("Accept an offer (customer-side). Rejects siblings + closes the request. Requires --reason.")
  ).action(async (idStr: string, offerIdStr: string, opts: WriteOpts) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryOfferAccept(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    offer
      .command("confirm <requestId> <offerId>")
      .description("Confirm an accepted offer → builds a keikka (provider). Requires --scheduled-at + --reason.")
      .requiredOption("--scheduled-at <iso>", "Scheduled keikka start (future ISO datetime)")
      .option("--pumppu <vehicleId>", "Pin one of your vehicles to the keikka", Number)
  ).action(
    async (
      idStr: string,
      offerIdStr: string,
      opts: WriteOpts & { scheduledAt: string; pumppu?: number }
    ) => {
      requireReason(opts);
      const body: { scheduledAt: string; pumppuId?: number } = { scheduledAt: opts.scheduledAt };
      if (opts.pumppu !== undefined) body.pumppuId = opts.pumppu;
      try {
        const client = await getClient();
        writeJson(await runJerryOfferConfirm(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), body, opts));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  addWriteFlagsToCommand(
    offer
      .command("withdraw <requestId> <offerId>")
      .description("Withdraw your sent offer before the customer accepts (pending → withdrawn; provider). Requires --reason.")
  ).action(async (idStr: string, offerIdStr: string, opts: WriteOpts) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryOfferWithdraw(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    offer
      .command("delete <requestId> <offerId>")
      .description("Hard-delete your OWN DRAFT offer (provider; draft only — sent offers 409, use withdraw). Requires --reason.")
  ).action(async (idStr: string, offerIdStr: string, opts: WriteOpts) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryOfferDelete(client, parseId(idStr, "requestId"), parseId(offerIdStr, "offerId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  // counts ─────────────────────────────────────────────────────────────────────
  j.command("counts")
    .description("Lifecycle counts (--mine customer view default, or --provider)")
    .option("--provider", "Provider badge counts (requires provider role)")
    .option("--mine", "Customer counts (default)")
    .action(async (opts: { provider?: boolean }) => {
      try {
        const client = await getClient();
        writeJson(await runJerryCounts(client, !!opts.provider));
      } catch (e) {
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
    .action(
      async (opts: {
        address: string;
        lat?: number;
        lng?: number;
        placeId?: string;
        formattedAddress?: string;
      }) => {
        try {
          const client = await getClient();
          writeJson(await runJerryCheckAddress(client, opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  // provider-settings ──────────────────────────────────────────────────────────
  const ps = j
    .command("provider-settings")
    .description("Per-provider BetoniJerry settings (contact, opening hours, description)");

  ps.command("get")
    .description("Read a provider's Jerry settings (defaults to your company)")
    .option("--asiakas <id>", "Target company asiakasId", Number)
    .action(async (opts: { asiakas?: number }) => {
      try {
        const client = await getClient();
        writeJson(await runJerryProviderSettingsGet(client, opts.asiakas));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    ps
      .command("set")
      .description("Upsert a provider's Jerry settings. Requires --reason.")
      .requiredOption(
        "--body <json>",
        "JSON: { jerryPersonId?, openingHours?, companyDescription?, maintainsOrderInfo? }"
      )
      .option("--asiakas <id>", "Target company asiakasId", Number)
  ).action(async (opts: WriteOpts & { body: string; asiakas?: number }) => {
    requireReason(opts);
    try {
      const client = await getClient();
      const parsed = parseJsonBodyFlag(opts.body) as Row;
      writeJson(
        await runJerryProviderSettingsSet(client, parsed, opts.asiakas, opts)
      );
    } catch (e) {
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
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("search <query>")
    .description("Search non-Jerry companies (Add picker)")
    .action(async (query: string) => {
      try {
        const client = await getClient();
        writeJson(await runJerryAdminSearch(client, query));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("detail [asiakasId]")
    .description("Company drill-down: people by role, vehicles, sijainnit Jerry status")
    .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)
    .action(async (idStr: string | undefined, opts: { asiakas?: number }) => {
      try {
        const client = await getClient();
        writeJson(await runJerryAdminDetail(client, resolveAsiakasTarget(idStr, opts.asiakas)));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    admin
      .command("enable [asiakasId]")
      .description("Enable the Jerry module for a company (audited). Requires --reason.")
      .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)
  ).action(async (idStr: string | undefined, opts: WriteOpts & { asiakas?: number }) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryAdminToggle(client, resolveAsiakasTarget(idStr, opts.asiakas), true, opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    admin
      .command("disable [asiakasId]")
      .description("Disable the Jerry module for a company (audited). Requires --reason.")
      .option("--asiakas <id>", "Target asiakasId (alias for the positional)", Number)
  ).action(async (idStr: string | undefined, opts: WriteOpts & { asiakas?: number }) => {
    requireReason(opts);
    try {
      const client = await getClient();
      writeJson(await runJerryAdminToggle(client, resolveAsiakasTarget(idStr, opts.asiakas), false, opts));
    } catch (e) {
      exitWithError(e);
    }
  });

  admin
    .command("requests")
    .description("System-wide tarjouspyyntö list with offer summary (filters)")
    .option("--status <csv>", "Status filter CSV (open,accepted,...)")
    .option("--from <date>", "createdAt from (YYYY-MM-DD / today / yesterday)", resolveDate)
    .option("--to <date>", "createdAt to (inclusive)", resolveDate)
    .option("--customer <id>", "Filter by customer asiakasId", Number)
    .option("--provider <id>", "Filter by provider asiakasId", Number)
    .option("--limit <n>", "Max rows (max 300)", (v: string) => Math.min(Number(v), 300))
    .action(async (opts: JerryAdminRequestsOpts) => {
      try {
        const client = await getClient();
        writeJson(await runJerryAdminRequests(client, opts));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("request-get <requestId>")
    .description("One request's full detail (admin view)")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        writeJson(await runJerryAdminRequestGet(client, parseId(idStr, "requestId")));
      } catch (e) {
        exitWithError(e);
      }
    });

  admin
    .command("request-offers <requestId>")
    .description("All offers on one request (admin view, no masking)")
    .action(async (idStr: string) => {
      try {
        const client = await getClient();
        writeJson(await runJerryAdminRequestOffers(client, parseId(idStr, "requestId")));
      } catch (e) {
        exitWithError(e);
      }
    });

  const adminReqAction = (name: string, desc: string, run: (c: ApiClient, id: number, f: WriteOpts) => Promise<unknown>) =>
    addWriteFlagsToCommand(admin.command(`${name} <requestId>`).description(desc))
      .action(async (idStr: string, opts: WriteOpts) => {
        requireReason(opts);
        try {
          const client = await getClient();
          writeJson(await run(client, parseId(idStr, "requestId"), opts));
        } catch (e) { exitWithError(e); }
      });

  adminReqAction("request-expire", "Force-expire a request (admin). Requires --reason.", runJerryAdminRequestExpire);
  adminReqAction("request-cancel", "Cancel any request (admin). Requires --reason.", runJerryAdminRequestCancel);
  adminReqAction("request-resend", "Re-run provider fan-out for a request (admin). Requires --reason.", runJerryAdminRequestResend);
  adminReqAction("request-delete", "Delete a draft request (admin). Requires --reason.", runJerryAdminRequestDelete);

  // request-extend needs --days/--until, so it is registered outside adminReqAction.
  addWriteFlagsToCommand(
    admin
      .command("request-extend <requestId>")
      .description("Extend a request's validity / reactivate it (admin). Requires --reason.")
      .option("--days <n>", "Make it valid for N more days from now (default 14)", Number)
      .option("--until <date>", "Absolute new expiry (ISO date/datetime)")
  ).action(async (idStr: string, opts: { days?: number; until?: string } & WriteOpts) => {
    requireReason(opts);
    if (opts.days != null && opts.until) failWith("Pass either --days or --until, not both", 4);
    try {
      const client = await getClient();
      writeJson(await runJerryAdminRequestExtend(client, parseId(idStr, "requestId"), opts));
    } catch (e) {
      exitWithError(e);
    }
  });
}
