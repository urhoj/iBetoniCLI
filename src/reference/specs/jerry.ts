// jerry specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { ONBOARDING_STATUS_KEYS, ONBOARDING_STATUSES, CHECK_ADDRESS_GATES, REQUEST_STATS_GROUPS, PROVIDER_LIST_TABS, ADMIN_REQUEST_STATUSES, SEARCH_DELIVERABLE, COMPANY_TYPES, ONBOARDING_SOURCES, ONBOARDING_EVENT_TYPES, ONBOARDING_EVENT_TYPES_ALL, ONBOARDING_EVENT_BODY_CAP } from "../../commands/jerry/index.js";
import { clearHint, apiErr, limitErr, COMMON_AUTH_ERRORS, SYSADMIN_403, ASIAKAS_FLAG_ERR, numParseErr, intParseErr, ASIAKAS_TARGET_FLAG, REASON_REQUIRED_FLAG, SEARCH_ALIAS_FLAG } from "./shared.js";

/** The `--tier` parse-guard row every onboarding list/add/set leaf shares. */
const TIER_PARSE_ERR = intParseErr("--tier", "pass 1 (priority) or 2 (secondary)");

export const JERRY_SPECS: CommandSpec[] = [

  // ─── jerry (39) — BetoniJerry marketplace ──────────────────────────────────
  {
    command: "ib jerry request list",
    description:
      "List BetoniJerry pump requests (tarjouspyynnöt). Default --mine returns the caller's own requests (GET /api/pumppuRequests/mine). --open returns the provider inbox of open requests in your delivery area (GET /api/pumppuRequests/open) and requires a provider company (isPumppuToimittaja); customer PII is masked there until your offer is accepted. --provider is the provider's own lifecycle view (GET /api/pumppuRequests/provider-list) — also provider-only, and includes your sent offers — selected by --tab <avoimet|tarjotut|voitetut|paattyneet> (default avoimet): avoimet = open requests to bid on, tarjotut = ones you have offered on (offer pending), voitetut = won (your offer accepted/confirmed), paattyneet = ended (expired, no_supply, or lost to another provider). --status (CSV) and --limit apply to --mine only. Whole-market visibility is system-admin only.",
    permissions: ["--open / --provider: provider company (isPumppuToimittaja)"],
    flags: [
      { name: "open", type: "boolean", description: "Provider inbox of open requests in your delivery area (provider role)" },
      { name: "mine", type: "boolean", description: "Your own requests (default)" },
      { name: "status", type: "string", description: "Filter --mine by status (CSV: open,pending_verification,accepted,cancelled,expired,no_supply)", allowed: ["open", "pending_verification", "accepted", "cancelled", "expired", "no_supply"] },
      { name: "limit", type: "number", default: "100", description: "Max rows for --mine (server caps at 200)" },
      { name: "provider", type: "boolean", description: "Provider lifecycle view via /provider-list (incl. sent offers)" },
      { name: "tab", type: "string", default: "avoimet", description: "With --provider: which lifecycle tab to return (avoimet|tarjotut|voitetut|paattyneet)", allowed: [...PROVIDER_LIST_TABS] },
    ],
    outputShape:
      "ListEnvelope<{ pumppuRequestId, status, createdAt, sentAt?, osoite, formattedAddress, totalM3|maaraM3, ... }> (fields differ between --mine and --open; --open is PII-masked)",
    errors: [
      limitErr("pass a positive integer; the server caps `--mine` at 200, so narrow with `--status` rather than raising the cap"),
      apiErr(400, "Unknown --tab", "use one of avoimet, tarjotut, voitetut, paattyneet (server-validated)"),
      apiErr(403, "Not a provider (for --open / --provider)", "switch to a provider company, or use --mine"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request list"],
    examples: [
      "ib jerry request list",
      "ib jerry request list --open",
      "ib jerry request list --mine --status open,accepted --limit 50",
      "ib jerry request list --provider --tab tarjotut",
    ],
  },
  {
    command: "ib jerry request get",
    aliases: ["ib jerry request show"],
    // The masking sentences at the end of this description are also stated in the
    // `jerry-lifecycle` TOPICS entry in reference/domain.ts (served by `ib help
    // jerry-lifecycle` and embedded in every `ib reference dump` primer) — keep both
    // in sync. Editing THIS file is exactly where the last drift started: c37700d
    // corrected two copies and missed domain.ts (fb#551).
    description:
      "Get one pump request. Default is the customer-owned recap (GET /api/pumppuRequests/:id, scoped to the caller's personId). --provider returns the provider-facing detail (GET /api/pumppuRequests/:id/provider-detail, requires provider role) including your own offer + attachments. This returns the FULL customer lead (name, address, lat/lng, phone, email) to every matched provider as soon as the request is open — it is NOT masked pre-acceptance. Masking applies to the `--open` inbox list and the fan-out email, not here.",
    permissions: ["--provider: provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "provider", type: "boolean", description: "Provider-facing detail view (provider role)" },
    ],
    outputShape:
      "default: { pumppuRequestId, status, asiakasId, maaraM3, osoite, lat, lng, ... } | --provider: { request:{...}, ownOffer:{...}|null, ownAttachments:[…], requestAttachments:[…], messageThreadId }",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId (and that you own it, or use --provider)"),
      apiErr(403, "Not a provider (for --provider)", "switch to a provider company"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry request get 4012", "ib jerry request get 4012 --provider"],
  },
  {
    command: "ib jerry request offers",
    description:
      "List the offers on a customer-owned request (GET /api/pumppuRequests/:id/offers). Drafts excluded; sorted pending-first then cheapest. Provider contact fields (jerryContactName/Phone, openingHours) are revealed only on the accepted offer.",
    auth: "any",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you own" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ pumppuOfferId, status, priceCents, vatPercent, availableFrom, cancellationTerms, extraNotes, priceTerms, validUntil, createdAt, updatedAt, asiakasNimi, ytunnus, asiakasId, messageThreadId, companyDescription, maintainsOrderInfo, jerryContactName, jerryContactPhone, openingHours, providerDistanceKm }> — jerryContactName/jerryContactPhone/openingHours are null on every row except the accepted offer; providerDistanceKm is null when the provider varikko or the worksite has no coordinates",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry request offers 4012", "ib jerry request offers 4012 --pretty"],
  },
  {
    command: "ib jerry request create",
    description:
      "Create a customer pump request / tarjouspyyntö (POST /api/pumppuRequests). Any authenticated user — this is the CUSTOMER side (distinct from `ib jerry offer create`, the provider bid). The worksite address is given positionally OR via --address (exactly one; both allowed only if they agree). The server geocodes the address and inserts the request as status:'open', immediately visible to every geographically-matching provider. Omit --asiakas to bill it to your auto-created private BetoniJerry customer account; pass --asiakas to use a company you have access to. Requires --reason.",
    auth: "any",
    args: [{ name: "address", type: "string", required: false, description: "Worksite address (osoite); pass it here OR as --address (exactly one)" }],
    flags: [
      { name: "address", type: "string", description: "Worksite address (osoite); alias for the positional" },
      { name: "pump-at", type: "string", description: "Pump datetime (pumppausaika; ISO, REQUIRED), e.g. 2026-06-17T09:00:00+03:00" },
      { name: "m3", type: "number", description: "Concrete volume m³ (maaraM3; REQUIRED, > 0)" },
      { name: "boom", type: "number", default: "0", description: "Required boom reach m (puomi)" },
      { name: "duration", type: "number", description: "Pump duration hours (kesto)" },
      { name: "line-length", type: "number", description: "Hose line length m (linjanPituus)" },
      { name: "notes", type: "string", description: "Free-text description shown to providers (kuvaus)" },
      { name: "asiakas", type: "number", description: "Customer asiakasId (omit → your private BetoniJerry account)" },
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, status:'open', asiakasId, personId, tyomaaId, geocoded } · { dryRun:true, wouldCreate:{ asiakasId, osoite, pumppuAika, totalM3, requiredPuomi, pumppuKesto, requiredLinja, notes }, validation:{ ok:true } } on --dry-run",
    errors: [
      ASIAKAS_FLAG_ERR,
      numParseErr("--boom", "pass the required boom reach in metres (omit for 0)"),
      numParseErr("--duration", "pass the pump duration in hours"),
      numParseErr("--line-length", "pass the hose line length in metres"),
      { origin: "client", exit: 4, match: "address", meaning: "Address missing, or given BOTH positionally and via --address with different values", remedy: "pass the address exactly once — positional or --address" },
      { origin: "client", exit: 4, match: "--m3", meaning: "--m3 is not a number > 0", remedy: "pass --m3 as a positive number of cubic metres" },
      apiErr(400, "Server-side validation: pumppausaika not a parseable datetime, whitespace-only osoite, or non-numeric asiakasId/puomi", "pass --pump-at as a full ISO datetime (e.g. 2026-06-17T09:00:00+03:00) and a non-empty address"),
      apiErr(403, "No access to --asiakas", "omit --asiakas, or target a company you belong to"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Customer side: creates the tarjouspyyntö itself, NOT a provider offer (that is `ib jerry offer create`).",
      "Created as status:'open' → immediately fans out to matching provider inboxes. Run `ib jerry check-address` first to preview which providers (if any) cover the address.",
      "--dry-run runs the server's synchronous validation and echoes the would-be request, touching no DB (no asiakas resolve/auto-create, no geocode, no insert) — so a bad --pump-at/--m3 still 400s under --dry-run.",
    ],
    seeAlso: ["ib jerry check-address", "ib jerry request list", "ib jerry offer create"],
    examples: [
      'ib jerry request create "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --reason "tilaus"',
      'ib jerry request create --address "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --boom 24 --notes "ahdas piha" --reason "tilaus"',
      'ib jerry request create "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --dry-run --reason "preview"',
    ],
  },
  {
    command: "ib jerry request cancel",
    description:
      "Cancel your OWN pump request (customer-side) — allowed only while no live offer exists (POST /api/pumppuRequests/:id/cancel). Sets status='cancelled'. Requires --reason.",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you own" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, status: 'cancelled' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [
      apiErr(404, "Request not found / not yours", "verify the requestId and that you own it"),
      apiErr(409, "Already has offers", "cannot cancel once an offer arrived"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request cancel 88 --reason "tilaus peruuntui"'],
  },
  {
    command: "ib jerry request decline",
    description:
      "Decline a request as a provider WITHOUT making an offer (POST /api/pumppuRequests/:id/decline). Your company bows out; --reason is stored and shown to the customer (who is emailed + pushed that a provider passed). The request leaves your Avoimet tab (moves to Päättyneet). Blocked (409) if you already have an active offer — use `ib jerry offer withdraw` instead. Idempotent. Requires provider role + --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you were sent" }],
    flags: [{ name: "reason", type: "string", description: "Decline reason — stored, shown to the customer, and audited (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, declined: true, hasOtherProviders } (or { …, alreadyDeclined: true }) · { dryRun: true, wouldDecline: { pumppuRequestId, reason } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not a recipient", "verify the requestId and that it was sent to your company"),
      apiErr(409, "You already have an offer", "withdraw the offer instead (ib jerry offer withdraw)"),
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request decline 88 --reason "kalusto varattu kyseiselle päivälle"'],
  },
  {
    command: "ib jerry request undecline",
    description:
      "Reverse a prior decline as a provider (POST /api/pumppuRequests/:id/undecline). The request returns to your Avoimet tab and is offerable again. Idempotent (no-op success if you had not declined). No customer notification. Requires provider role + --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you previously declined" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, undeclined: boolean } · { dryRun: true, wouldUndecline: { pumppuRequestId } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not a recipient", "verify the requestId and that it was sent to your company"),
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request undecline 88 --reason "kalusto vapautui"'],
  },
  {
    command: "ib jerry offer create",
    description:
      "Create or update (upsert) YOUR offer on a request (POST /api/pumppuRequests/:id/offers). Provider company only (isPumppuToimittaja). A new offer starts as 'draft' (invisible to the customer) — make it visible with `ib jerry offer send`. Re-running while the offer is still draft/pending edits it in place; once accepted/rejected/withdrawn it is final (409). --price-cents is the canonical price (integer cents, 1..99999900) matching exactly what the API stores; --maintains-order-info (true|false) overrides the provider default for this offer only (omit to inherit). Requires --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "price-cents", type: "number", description: "Offer price in cents (REQUIRED; integer 1..99999900)" },
      { name: "vat-percent", type: "number", default: "25.5", description: "VAT percent" },
      { name: "price-terms", type: "string", description: "Price-estimate terms (Hinta-arvion ehdot) shown to the customer" },
      { name: "valid-until", type: "string", description: "Offer valid-until (ISO datetime; server default +7d)" },
      { name: "available-from", type: "string", description: "Earliest availability (ISO datetime; stored, not shown on the BetoniJerry customer card)" },
      { name: "extra-notes", type: "string", description: "Free-text notes shown to the customer" },
      { name: "cancellation-terms", type: "string", description: "Per-offer cancellation terms (stored; BetoniJerry shows a platform-standard peruutusehdot, so this is NOT rendered on the customer card)" },
      { name: "maintains-order-info", type: "string", description: "Override provider default (true|false); omit to inherit" },
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuOfferId, status:'draft', created, messageThreadId } · { dryRun:true, wouldUpsert:{ pumppuRequestId, priceCents, vatPercent, priceTerms, validUntil, availableFrom, extraNotes, cancellationTerms, maintainsOrderInfo } } on --dry-run",
    errors: [
      { origin: "client", exit: 4, match: "--price-cents", meaning: "--price-cents is not an integer in 1..99999900 — rejected locally before anything is sent (this guard is stricter than the server's, so a bad price never reaches a server 400)", remedy: "pass --price-cents as an integer 1..99999900 (cents, not euros)" },
      numParseErr("--vat-percent", "pass a VAT percent between 0 and 100 (e.g. 25.5)"),
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      apiErr(404, "Request not found", "verify requestId"),
      apiErr(409, "Request not open / expired, or offer no longer editable", "the request was closed, or your offer is already accepted/rejected"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      'ib jerry offer create 4012 --price-cents 45000 --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --vat-percent 25.5 --maintains-order-info false --extra-notes "sis. siirtymat" --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --price-terms "Arvioitu hinta; laskutus toteutuneen mukaan" --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --dry-run --reason "preview"',
    ],
  },
  {
    command: "ib jerry offer send",
    description:
      "Send a draft offer to the customer (draft → 'pending'; POST /api/pumppuRequests/:id/offers/:offerId/send). Provider company only; you must own the offer. Two-stage by design: create the draft, attach files, then send. Requires --reason.",
    permissions: ["provider company (isPumppuToimittaja); owns the offer"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "pumppuOfferId you own" },
    ],
    flags: [
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuOfferId, status:'pending' } · { dryRun:true, wouldUpdate:{ pumppuRequestId, pumppuOfferId, status:'pending' } } on --dry-run",
    errors: [
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      apiErr(409, "Offer not in draft / not owned", "only a draft offer you own can be sent"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer send 4012 55 --reason "lahetä tarjous"', "ib jerry offer send 4012 55 --dry-run --reason preview"],
  },
  {
    command: "ib jerry offer accept",
    description:
      "Accept an offer (CUSTOMER side; POST /api/pumppuRequests/:id/offers/:offerId/accept). Flips this offer to 'accepted', sibling offers to 'rejected', and the parent request to 'accepted' in one transaction. Caller must own the request (its personId) — this is NOT a provider action. Requires --reason.",
    permissions: ["owns the request (customer personId)"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId you own" },
      { name: "offerId", type: "number", description: "pumppuOfferId to accept" },
    ],
    flags: [
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, pumppuOfferId, keikkaId:null, status:'accepted' } · { dryRun:true, wouldAccept:{ pumppuRequestId, pumppuOfferId, status:'accepted' } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId and that you own it"),
      apiErr(409, "Offer no longer acceptable", "a sibling was already accepted, or the offer expired"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer accept 4012 55 --reason "valittu toimittaja"'],
  },
  {
    command: "ib jerry offer confirm",
    description:
      "Confirm an accepted offer (PROVIDER side; POST /api/pumppuRequests/:id/offers/:offerId/confirm).",
    permissions: ["provider company (isPumppuToimittaja); owns the offer"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "pumppuOfferId you own (must be 'accepted')" },
    ],
    flags: [
      { name: "scheduled-at", type: "string", description: "Scheduled keikka start (REQUIRED; future ISO datetime)" },
      { name: "pumppu", type: "number", description: "vehicleId to pin to the keikka (must be yours)" },
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, pumppuOfferId, status:'confirmed', keikkaId, scheduledAt } · { dryRun:true, wouldConfirm:{ pumppuRequestId, pumppuOfferId, status:'confirmed', scheduledAt, pumppuId } } on --dry-run",
    errors: [
      apiErr(400, "scheduledAt missing/invalid/in the past, or pumppuId not yours", "pass --scheduled-at as a future ISO datetime; --pumppu must be your vehicleId"),
      intParseErr("--pumppu", "pass your vehicleId as a positive integer"),
      apiErr(403, "Not a provider / offer not yours", "switch to the owning provider company"),
      apiErr(404, "Request / offer not found", "verify requestId + offerId"),
      apiErr(409, "Offer not in 'accepted' state", "the customer must accept the offer before you confirm"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Heavyweight, real side effects: flips the offer accepted → 'confirmed' AND builds a keikka in your grid (broadcasts keikka:created, notifies the customer, inherits the vehicle's day driver).",
      "Call only after the customer accepts and you've agreed a date by phone.",
      "--scheduled-at (future ISO datetime) is required.",
      "--pumppu optionally pins one of your vehicles.",
    ],
    seeAlso: ["ib jerry offer accept", "ib jerry request get"],
    examples: [
      "ib jerry offer confirm 4012 55 --scheduled-at 2026-06-15T08:00:00Z --reason vahvistettu",
      "ib jerry offer confirm 4012 55 --scheduled-at 2026-06-15T08:00:00Z --pumppu 7 --dry-run --reason preview",
    ],
  },
  {
    command: "ib jerry offer withdraw",
    description:
      "Withdraw YOUR sent offer before the customer accepts it (POST /:id/offers/:offerId/withdraw). pending → withdrawn. Provider-only; you must own the offer. Requires --reason.",
    permissions: ["isProvider"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "your pumppuOfferId" },
    ],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, status: 'withdrawn' } or { dryRun: true, wouldUpdate: { pumppuOfferId, status } }",
    errors: [
      apiErr(403, "Not a provider", "use a pump-company token"),
      apiErr(404, "Offer not found / not yours", "verify requestId + offerId"),
      apiErr(409, "Already resolved", "cannot withdraw once accepted/confirmed"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer withdraw 77 5 --reason "kalusto varattu"'],
  },
  {
    command: "ib jerry offer delete",
    description:
      "Hard-delete YOUR OWN DRAFT offer (DELETE /:id/offers/:offerId). Provider-only; you must own the offer; DRAFT status ONLY — a sent offer (pending/accepted/…) returns 409, use `ib jerry offer withdraw` for a pending one. The offer's attachments are soft-deleted server-side; the (request, provider) message thread is left in place for reuse. Requires --reason.",
    permissions: ["isProvider"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "your DRAFT pumppuOfferId" },
    ],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, pumppuOfferId, deleted: true } or { dryRun: true, wouldDelete: { pumppuOfferId, status } }",
    errors: [
      apiErr(403, "Not a provider", "use a pump-company token"),
      apiErr(404, "Offer not found / not yours", "verify requestId + offerId"),
      apiErr(409, "Not a draft", "only a draft offer can be deleted; use withdraw for a sent offer"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer delete 77 5 --reason "väärä luonnos"'],
  },
  {
    command: "ib jerry counts",
    description:
      "Lifecycle counts. Default --mine returns the customer view (GET /api/pumppuRequests/mine/counts: draft/open/pending_verification/accepted/cancelled/expired/no_supply). --provider returns the provider badge counts (GET /api/pumppuRequests/provider-counts: avoimet/tarjotut/voitetut/voitetutActionRequired/paattyneet) plus this company's Jerry membership state, and requires a provider company.",
    permissions: ["--provider: provider company (isPumppuToimittaja)"],
    flags: [
      { name: "provider", type: "boolean", description: "Provider badge counts (provider role)" },
      { name: "mine", type: "boolean", description: "Customer counts (default)" },
    ],
    outputShape:
      "--mine: { draft, open, pending_verification, accepted, cancelled, expired, no_supply } | --provider: { avoimet, tarjotut, voitetut, voitetutActionRequired, paattyneet, supportUnread, jerryActive, application: { status, createdTime } | null }",
    errors: [
      apiErr(403, "Not a provider (for --provider)", "switch to a provider company, or use --mine"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--provider carries three non-count keys beyond the badge numbers: supportUnread (per-PERSON, not per-company: support threads with a message you have not read), jerryActive (the HAS_JERRY setting is on — the company is live in the marketplace), and application (this company's own jerryOnboarding row, null when it never applied). jerryActive is the cheapest single answer to 'is my company live in Jerry?'.",
    ],
    examples: ["ib jerry counts", "ib jerry counts --provider"],
  },
  {
    command: "ib jerry stats",
    description:
      "Weekly BetoniJerry funnel as a time series (GET /api/admin/jerry-searches/weekly): visitors → address searches → wizard sessions → requests sent → offers. Monday-start weeks, oldest first. This is the trend view; `ib jerry counts` is the lifecycle snapshot of your own requests. Use it to answer 'is demand growing' and 'are providers still answering', neither of which a single-window number can show.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "weeks", type: "number", description: "How many weeks back (default 12, capped at 104)" },
    ],
    outputShape:
      "{ weeks: [{ weekStart, visitors, wizardVisitors, authedVisitors, searches, coveredSearches, noSupplySearches, wizardSessions, reachedReview, requestsSent, noSupplyRequests, offersSent, offersAccepted }] }",
    errors: [
      intParseErr("--weeks", "pass a positive integer number of weeks"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request stats", "ib jerry admin searches funnel", "ib jerry counts"],
    notes: [
      "`visitors` is null — not 0 — for any week before 2026-08-12, when the daily visitor rollup started. The presence heartbeat was ephemeral until then, so those weeks have no visitor number and never can. Reading a null as 0 would say 'nobody came' when the truth is 'we were not counting yet'.",
      "`wizardSessions` changed UNIT on 2026-08-17 (fb#511) — do not compare across that date. Before it, the wizard keyed telemetry on a per-BROWSER localStorage id, so one person's five runs counted as 1 and the same browser recounted in each week it was active; earlier weeks therefore read LOW. From 2026-08-17 betonijerry sends a per-run id, so newer weeks really are wizard runs. No backfill is possible.",
      "`wizardSessions` and `reachedReview` are PRE-CLAIM only, before and after that change: BetonijerryAnonymousEvent stops recording once a server draft exists, so a returning user who resumes a draft is invisible here. That half is a genuine undercount — do not read either as total wizard usage.",
      "`reachedReview` means 'completed step 4', i.e. landed on Vaihe 5 (tarkista). It is NOT step >= 5, which is structurally 0 because the wizard emits a step only when advancing off it and Vaihe 5 ends in Lähetä (fb#457).",
      "`offersSent` excludes drafts — an unsent draft offer is not an answer to the customer. `offersAccepted` counts both 'accepted' and 'confirmed'.",
      "Not to be confused with `ib jerry admin request stats`, which is also weekly but covers ONLY requests (with a per-status split and an arbitrary --from/--to window). Use that one to dissect request outcomes; use this one to see the whole funnel end to end, including the demand upstream of any request. Both bucket in Helsinki time and agree on which week a request belongs to.",
    ],
    examples: ["ib jerry stats", "ib jerry stats --weeks 26"],
  },
  {
    command: "ib jerry check-address",
    description:
      "Geofence feasibility probe (POST /api/pumppuRequests/checkAddress; the route is unauthenticated, but ib calls it with your session): which provider varikot cover an address. The single best tool for diagnosing 'no offers'. --address is required (the `osoite` body field); if --lat/--lng/--place-id are all supplied the server trusts them instead of re-geocoding. Not a mutation, so no write-safety flags. Rate-limited 20/min per IP. The `providers` array is only included when the token is a developer/admin.",
    auth: "any",
    flags: [
      { name: "address", type: "string", description: "Street address to check (REQUIRED; sent as `osoite`)" },
      { name: "lat", type: "number", description: "Latitude (trusted only with --lng + --place-id)" },
      { name: "lng", type: "number", description: "Longitude (trusted only with --lat + --place-id)" },
      { name: "place-id", type: "string", description: "Google placeId (lets the server trust client coords)" },
      { name: "formatted-address", type: "string", description: "Google formatted address" },
      { name: "boom", type: "number", description: "Required boom (m) — keeps varikot with enough REACH: puomiMax NULL or >= it (absent/0 = no boom filter)" },
      { name: "explain", type: "boolean", description: "Add considered[] — per-varikko exclusion reasons for non-matching depots (developer/admin only)" },
      { name: "gate", type: "string", description: "With --explain: CSV of exclusion reasons to include (company-gate|provider-dead|no-coords|not-enrolled|radius|boom). Default omits company-gate", allowed: [...CHECK_ADDRESS_GATES] },
      { name: "asiakas", type: "number", description: "With --explain: force-include this company's varikot even if not yet Jerry-enabled (surfaces company-gate)" },
    ],
    outputShape:
      "{ geocoded: boolean, deliverable?: boolean, lat?, lng?, placeId?, formattedAddress?, providerCount?, nearestVarikkoKm?, providers?: [{ asiakasId, asiakasNimi, distanceKm }], considered?: [{ asiakasId, asiakasNimi, sijaintiId, excludedBy: 'company-gate'|'provider-dead'|'no-coords'|'not-enrolled'|'radius'|'boom', detail }], consideredSuppressed?: { [gate]: count } }",
    errors: [
      apiErr(400, "Empty/whitespace-only --address (an omitted --address is caught locally by the parser, which answers with its own prescriptive envelope)", "pass a non-empty street address"),
      numParseErr("--lat", "pass the latitude as a number"),
      numParseErr("--lng", "pass the longitude as a number"),
      { origin: "client", exit: 4, match: "--boom", meaning: "--boom not a non-negative number", remedy: "pass metres ≥ 0, or omit for no boom filter" },
      { origin: "client", exit: 4, match: "--asiakas", meaning: "--asiakas without --explain, or not a positive integer", remedy: "add --explain, or pass a positive asiakasId" },
      { origin: "client", exit: 4, match: "--gate", meaning: "--gate without --explain, or an unknown reason name", remedy: "add --explain; valid reasons are company-gate, provider-dead, no-coords, not-enrolled, radius, boom" },
      apiErr(429, "Rate limit (20/min/IP)", "wait and retry"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "A varikko counts toward providerCount only when ALL of these hold: the company has isPumppuToimittaja = 1, the company has the HAS_JERRY setting on (ib jerry admin enable), the sijainti is enrolled (jerryActiveUntil in the future, ib sijainti set-jerry --on) with maxDeliveryDistance covering the point, and — when a boom is stated — the sijainti has enough reach (puomiMax IS NULL or >= boom; puomiMin is stored but NOT matched on, fb#415).",
      "--explain answers 'why no offers?': considered[] lists the NON-matching varikot (passing ones are in providers[]), each tagged with the FIRST gate it failed. Gate priority puts COMPANY-level reasons above DEPOT-level ones — company-gate → provider-dead → no-coords → not-enrolled → radius → boom — so the reason reported is the most upstream blocker, the one to fix first: adding coordinates to a depot changes nothing for a company that was never enrolled. Business-sensitive, so returned only to developer/admin tokens, exactly like providers[].",
      "company-gate is OMITTED by default: it only says 'this company was never in the programme', and on a live Helsinki probe it was 93 of 110 rows across 17 companies, burying the actionable ones. Whatever is withheld is counted in consideredSuppressed, so nothing disappears silently. Pass --gate company-gate (alone or with others) to see it, or --asiakas <id> to surface it for ONE company during onboarding — which is when it is a real answer.",
      "--gate narrows further: --gate no-coords,radius answers 'which enrolled depots are misconfigured?' without the rest. An unknown reason name exits 4 rather than silently narrowing the view, since a shorter list reads as 'nothing else is wrong'.",
    ],
    seeAlso: ["ib jerry admin list"],
    examples: [
      "ib jerry check-address --address 'Mannerheimintie 1, Helsinki'",
      "ib jerry check-address --address 'Hämeenkatu 1, Tampere' --lat 61.498 --lng 23.761 --place-id ChIJxxxx",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain --gate no-coords,not-enrolled",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain --asiakas 812",
    ],
  },
  {
    command: "ib jerry coverage",
    description:
      "Developer view of BetoniJerry supply coverage: the candidate-area table (covered + not, with providerCount + region) plus every enrolled provider depot circle (company, lat/lng, delivery radius km, boom range). Reuses the live geofence rule (services/varikkoMatching + modules/betonijerry/coverageAreas), so it matches real request feasibility. Use it to align ad geo-targeting to actual supply.",
    auth: "any",
    tier: "developer",
    flags: [],
    outputShape:
      "{ summary: { varikkoCount, providerCount, coveredAreas, coveredRegions: string[] }, coveredRegions: string[], areas: { key, listLocative, tailRegion, probeLat, probeLng, covered, providerCount }[], varikot: { asiakasId, asiakasNimi, sijaintiId, sijaintiNimi, lat, lng, maxDeliveryDistanceKm, puomiMin, puomiMax, jerryActiveUntil }[], computedAt } — `coveredRegions` (distinct tailRegions of covered areas) is the Google-Ads geo-targeting answer.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib jerry coverage"],
  },
  {
    command: "ib jerry email-activity",
    description:
      "Developer SendGrid deliverability diagnostic for betonijerry.fi (GET /api/betonijerry/email-activity). READ-ONLY: reports domain-authentication validity (DKIM/DMARC), aggregate send stats over the window (delivered/bounces/spam with rate %), and recent suppressions (bounces/blocks/spam_reports/invalid_emails, incl. how many are @betonijerry.fi). Backed by a SEPARATE read-only SendGrid key on the server (KV sendgrid-diag-key) — never the app's mail.send key; the report includes a key.readOnly guardrail. Use it to watch deliverability as email volume grows (e.g. the re-added loser-notification #5).",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "days", type: "number", default: "7", description: "Window in days (1..90)" },
      { name: "domain", type: "string", default: "betonijerry.fi", description: "Sending domain to report on" },
    ],
    outputShape:
      "{ domain, days, checkedAt, key:{ readOnly, hasWhitelabel, hasSuppression, hasStats }, domainAuth:{ valid, records:{ mail_cname, dkim1, dkim2 } }, suppressions:{ bounces|blocks|spam_reports|invalid_emails: { count, forDomain, recent[] } }, stats:{ delivered, bounces, spam_reports, bounceRatePct, spamRatePct }, verdict:{ domainAuthValid, deliverabilityFlags[] } }",
    errors: [
      intParseErr("--days", "pass a positive integer window in days (1..90; values above 90 are silently capped)"),
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(503, "Diagnostic key not configured on this backend", "set KV secret sendgrid-diag-key (read-only SendGrid key)"),
    ],
    examples: ["ib jerry email-activity", "ib jerry email-activity --days 30 --pretty"],
  },
  {
    command: "ib jerry provider-settings get",
    aliases: ["ib jerry provider-settings show"],
    description:
      "Read a provider company's BetoniJerry settings — contact person, opening hours, company description, maintainsOrderInfo (GET /api/jerry-provider-settings). Defaults to the caller's own company; --asiakas targets another company you have edit rights on. Returns defaults when no row exists yet.",
    permissions: ["edit-tier on the target company (tarjousAdmin / company admin)"],
    flags: [
      { name: "asiakas", type: "number", description: "Target company asiakasId (default: your own)" },
    ],
    outputShape:
      "{ asiakasId, jerryPersonId, jerryPersonName, jerryPersonPhone, jerryPersonEmail, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsentAt, publicListingConsentBy }",
    errors: [
      ASIAKAS_FLAG_ERR,
      apiErr(403, "No edit rights on company", "use a tarjousAdmin/admin token for that company"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry provider-settings get", "ib jerry provider-settings get --asiakas 1402"],
  },
  {
    command: "ib jerry provider-settings set",
    description:
      "Upsert a provider company's BetoniJerry settings (PUT /api/jerry-provider-settings). Partial-payload-safe: only the body keys present are written (omit a key to preserve it). jerryPersonId must belong to the target company. --asiakas targets another company. Returns the FULL saved settings (no follow-up GET needed) plus changed:boolean (whether anything actually changed vs an idempotent no-op). companyDescription is nvarchar — ä/ö are preserved. Requires --reason. Writable keys: jerryPersonId, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsent. `publicListingConsent` is a BOOLEAN intent flag — the server stamps publicListingConsentAt/By from your token; never send a timestamp. Re-granting an already-granted consent does not re-stamp the original date. On Windows PowerShell use --from-json <file>: PowerShell splits a quoted --body value on its inner double-quotes.",
    permissions: ["edit-tier on the target company (tarjousAdmin / company admin)"],
    flags: [
      { name: "body", type: "json", description: "JSON: { jerryPersonId?, offerNotificationEmail?, openingHours?, companyDescription?, maintainsOrderInfo?, website?, publicSlug?, publicListingConsent? }. Mutually exclusive with --from-json. ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "from-json", type: "string", description: "Read the JSON body from a file (or - for stdin); shell-safe alternative to --body. Mutually exclusive with --body." },
      { name: "email", type: "string", description: "Address tarjouspyyntö mail is DELIVERED to (offerNotificationEmail). May be a shared inbox — it is a mailbox, not a login, so jerryPersonId stays a named person who signs in. Wins over jerryPersonId's own address when set, and over the same key in --body; " + clearHint("--email") + " and fall back to it." },
      { name: "asiakas", type: "number", description: "Target company asiakasId (default: your own)" },
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ asiakasId, jerryPersonId, jerryPersonName, jerryPersonPhone, jerryPersonEmail, offerNotificationEmail, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsentAt, publicListingConsentBy, changed } · { dryRun: true, wouldUpdate: {...} } on --dry-run",
    errors: [
      ASIAKAS_FLAG_ERR,
      apiErr(400, "Invalid field / contact not in company", "check jerryPersonId belongs to the company; offerNotificationEmail must be a valid address"),
      apiErr(403, "No edit rights on company", "use a tarjousAdmin/admin token for that company"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "On Windows PowerShell inline --body JSON often fails (the shell strips the inner double-quotes) — pass --from-json <file|-> (a file, or - for stdin) to avoid shell quoting entirely.",
      "Before fb#532 jerryPersonId did both jobs — WHERE offer mail lands and WHO signs in — which pushed operators into configuring shared login accounts. The welcome email forbids those on GDPR/audit grounds, and the one account set up that way went three weeks without a single login.",
    ],
    examples: [
      'ib jerry provider-settings set --body \'{"openingHours":"ma-pe 7-16","maintainsOrderInfo":true}\' --reason "update opening hours"',
      'ib jerry provider-settings set --from-json ./settings.json --reason "update opening hours"',
      'ib jerry provider-settings set --body \'{"jerryPersonId":6233}\' --asiakas 1402 --reason "set contact"',
      'ib jerry provider-settings set --email tarjoukset@yritys.fi --asiakas 1409 --reason "route offers to the shared inbox"',
    ],
  },
  {
    command: "ib jerry admin list",
    description:
      "List Jerry-active companies (isPumppuToimittaja + HAS_JERRY setting) with per-company counts (admins, tarjousAdmins, pumpparit, vehicles, Jerry/non-Jerry varikot, matchable varikot) AND login reality (lastLoginTime, jerryContactLastLoginTime). GET /api/admin/jerry-companies. System-admin only. TWO health checks: matchableVarikkoCount 0 means Jerry-active but its varikot fail the geofence, so it CANNOT receive a tarjouspyyntö (diagnose with `ib jerry check-address --explain`); jerryContactLastLoginTime null means it receives them but the contact they are mailed to has never signed in, so nobody there can open one.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "with-notification", type: "boolean", description: "Add the RESOLVED tarjouspyyntö recipient to every row (notificationSource / notificationEmail / notificationRecipientCount) — the whole fleet's real notification addresses in ONE call. Opt-in: costs the backend 1-4 extra queries per company." },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, asiakasNimi, adminCount, tarjousAdminCount, pumppariCount, vehicleCount, sijaintiJerryCount, sijaintiNonJerryCount, ajoneuvotEnabled, matchableVarikkoCount?, lastLoginTime?, jerryContactPersonId?, jerryContactLastLoginTime?, notificationSource?, notificationEmail?, notificationRecipientCount? }>. The three notification* fields appear only with --with-notification. matchableVarikkoCount counts varikot that pass the REAL fan-out geofence (enrolled AND coords AND maxDeliveryDistance > 0); sijaintiJerryCount counts enrolment only, so matchableVarikkoCount 0 with sijaintiJerryCount > 0 means the company is Jerry-active but invisible to every tarjouspyyntö. lastLoginTime is the MAX over the company's admins/tarjousAdmins; jerryContactLastLoginTime is the jerry contact's own — they differ when the company is alive but the notified address is dead. jerryContactPersonId null means no contact is configured at all (a different defect from a configured contact who never signed in).",
    errors: [
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "The health check is `matchableVarikkoCount === 0 && sijaintiJerryCount > 0` — Jerry-active, varikot enrolled, yet invisible to every tarjouspyyntö. Diagnose the individual depot with `ib jerry check-address --explain`.",
      "The second health check is `jerryContactLastLoginTime === null` — the enrolment is live and mailed, but the recipient has never signed in, so they cannot see customer details or leave an offer. Two providers sat like this for weeks looking identical to healthy rows; finding them used to need a per-person `ib person activity` sweep (fb#532). Remedy: re-send the tervetuloa email (it now explains the one-time-code login), or check whether offerNotificationEmail should carry the shared inbox instead.",
      "--with-notification is the third check, and the one jerryContactPersonId cannot answer: it reports the RESOLVED address per provider and which branch produced it (offerNotificationEmail | jerryContactPerson | billingEmail | adminUser). Scan for `billingEmail` (the request lands in an invoicing inbox, not with a person who can answer it) and for a null source (the chain reached NOBODY). Resolved by the same function the real send calls, so it cannot drift from what is emailed (fb#567).",
    ],
    seeAlso: ["ib jerry check-address", "ib jerry admin detail"],
    examples: ["ib jerry admin list", "ib jerry admin list --pretty", "ib jerry admin list --with-notification"],
  },
  {
    command: "ib jerry admin search",
    description:
      "Search companies NOT yet fully Jerry-enabled, for the Add picker (GET /api/admin/jerry-companies/search?q=). Name LIKE match, min 2 chars, top 20. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "query", type: "string", required: false, description: "name search (min 2 chars) — or pass --search" }],
    flags: [
      SEARCH_ALIAS_FLAG,
    ],
    outputShape: "ListEnvelope<{ asiakasId, name }>",
    errors: [
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry admin search Betoni"],
  },
  {
    command: "ib jerry admin detail",
    description:
      "Company Jerry drill-down: people by role (admins/tarjousAdmins/pumpparit) WITH each person's lastLoginTime, vehicles, and each sijainti's Jerry enrolment status (GET /api/admin/jerry-companies/:asiakasId/detail). System-admin only. Use it to name WHO at a company has never signed in once `ib jerry admin list` flags the company (fb#532).",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
    ],
    outputShape:
      "{ asiakasNimi, admins:[{personId,name,lastLoginTime}], tarjousAdmins:[…], pumpparit:[…], vehicles:[{vehicleId,vehicleRegNo}], sijainnit:[{sijaintiId,name,isJerry}], notification:{jerryPersonId,source,recipients:[{email,name,personId}]} }. lastLoginTime null = that person has never signed in.",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      apiErr(404, "Company not found", "the asiakasId has no asiakas row — distinct from a real company with no Jerry config, which returns 200 with empty arrays"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "`notification` answers WHERE this provider's tarjouspyyntö actually lands, and WHICH branch produced it: source is offerNotificationEmail | jerryContactPerson | billingEmail | adminUser, in that precedence. It is resolved by the same function the real send calls, so it cannot drift from what is emailed (fb#567).",
      "`source: \"billingEmail\"` is an operational smell — the request reaches an invoicing inbox rather than a person who can answer it. `source: null` with empty recipients is worse: the chain fell through every branch and NOBODY is notified.",
      "`notification.jerryPersonId` is the CONFIGURED contact, which is a different question from the resolved one: an explicit offerNotificationEmail outranks it, so a company can have a contact set and still be notified elsewhere.",
      "Deploy-gated: `notification` is simply absent against a backend that predates it.",
    ],
    seeAlso: ["ib jerry admin list"],
    examples: ["ib jerry admin detail 1402", "ib jerry admin detail --asiakas 1402"],
  },
  {
    command: "ib jerry admin enable",
    description:
      "Enable the BetoniJerry module for a company — the audited toggle that sets BOTH isPumppuToimittaja and the HAS_JERRY setting (POST /api/admin/jerry-companies/:asiakasId/enable), auto-provisions the modules a provider needs, and returns a readiness `validation` payload naming what it could NOT provision. Change-tracked via the asiakasSql proc paths. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, validation?: { ok, summary: { [severity]: 'passed/total' }, missing: [{ id, severity, titleFi, detail }] } } or { dryRun: true, wouldUpdate: { asiakasId, enable: true } }",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      SYSADMIN_403,
      apiErr(404, "Company not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "`validation` is the post-enable readiness summary — the `jerry` validation profile re-run against the company, with `missing` listing the still-failing checks (TarjousAdmin role, grid vehicle, Jerry-ready varikko coordinates, complete contact details): the parts that need real data and cannot be auto-provisioned. Enable itself already committed, so a non-ok validation is a TODO list, not a failure.",
      "It is best-effort and enable-only: the key is ABSENT (not null) when the validation run itself fails, and `disable` never returns it. Re-run the same checks any time with `ib validate --profile jerry --asiakas <id>`.",
    ],
    seeAlso: ["ib validate"],
    examples: ['ib jerry admin enable 1402 --reason "onboard provider"', "ib jerry admin enable --asiakas 1402 --dry-run --reason preview"],
  },
  {
    command: "ib jerry admin disable",
    description:
      "Disable the BetoniJerry module for a company — clears BOTH isPumppuToimittaja and the HAS_JERRY setting (POST /api/admin/jerry-companies/:asiakasId/disable). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true } or { dryRun: true, wouldUpdate: { asiakasId, enable: false } }",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      SYSADMIN_403,
      apiErr(404, "Company not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin disable 1402 --reason "offboard provider"', "ib jerry admin disable --asiakas 1402 --dry-run --reason preview"],
  },
  {
    command: "ib jerry admin onboarding list",
    description:
      "List provider-onboarding prospects — pipeline status, tier, outreach contact, live Jerry-active flag, and muistutusDue (email1b reminder due) per company (GET /api/admin/jerry-onboarding). Filters: --status, --tier, --due (client-side on muistutusDue), --search (client-side substring on company name / outreach / contact fields). System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: `Filter by pipeline status key: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
      { name: "tier", type: "number", description: "Tier filter (1 priority / 2 secondary)" },
      { name: "due", type: "boolean", description: "Only rows where the email1b reminder is due (parked rows are excluded — a hold suppresses the reminder until it lapses)" },
      { name: "search", type: "string", description: "Case-insensitive substring on asiakasNimi / outreachName / outreachEmail / contactPersonName / contactPersonEmail" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, asiakasNimi, tier, status, alue, outreachEmail, muistiinpanot, jerryActive, lastEventTime, lastNote, lastNoteType, lastNoteTime, parkedUntil, parked, muistutusDue }>",
    errors: [TIER_PARSE_ERR, SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    notes: [
      "`lastNote` previews (200 chars) the most recent HUMAN-written event — note/call/response, with `lastNoteType` naming which — so the reason behind a status is visible without opening the trail. `status` alone cannot tell a ruled-out prospect from a deliberately held one; read `lastNote`/`muistiinpanot` before acting on a terminal status, and `ib jerry admin onboarding events <asiakasId>` for the full history. Deploy-gated: the three lastNote* fields are absent until puminet5api ships them.",
    ],
    seeAlso: ["ib jerry admin onboarding events"],
    examples: ["ib jerry admin onboarding list --due", "ib jerry admin onboarding list --search transsinkko"],
  },
  {
    command: "ib jerry admin onboarding add",
    description:
      "Add a company to the provider-onboarding pipeline (POST /api/admin/jerry-onboarding). One row per asiakasId; duplicate exits 4. Emails are NOT sent via CLI — sending stays a human action in /admin. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "tier", type: "number", description: "1 priority / 2 secondary" },
      { name: "malli", type: "string", description: "Email variant label — FREE TEXT (not server-validated); the convention is A or B" },
      { name: "kanava", type: "string", description: "Preferred channel, free text" },
      { name: "alue", type: "string", description: "Operating area ({alue} merge field)" },
      { name: "company-type", type: "string", description: "Company category: pumppu | betoni | all | owner", allowed: [...COMPANY_TYPES] },
      { name: "source", type: "string", default: "manual", description: "How the prospect entered the pipeline: manual | import | scheduled", allowed: [...ONBOARDING_SOURCES] },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ jerryOnboardingId } · { dryRun: true, wouldCreate: { asiakasId } } on --dry-run",
    errors: [
      apiErr(400, "Prospect already exists / company not found / unknown --source or --company-type", "check asiakasId; --source is manual|import|scheduled, --company-type is pumppu|betoni|all|owner"),
      TIER_PARSE_ERR,
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin onboarding add 1389 --tier 2 --alue "Oulu" --source scheduled --reason "uusi yritys rekisterista"'],
  },
  {
    command: "ib jerry admin onboarding set",
    description:
      "Partial-update an onboarding prospect (PUT /api/admin/jerry-onboarding/:asiakasId) — status, tier, notes, outreach contact override. Only the flags you pass are written; a status change also writes a status_change history event. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "status", type: "string", description: `Pipeline status key: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
      { name: "tier", type: "number", description: "1/2" },
      { name: "malli", type: "string", description: "Email variant label — FREE TEXT (not server-validated); the convention is A or B" },
      { name: "kanava", type: "string", description: "Preferred channel" },
      { name: "alue", type: "string", description: "Operating area" },
      { name: "company-type", type: "string", description: "Company category: pumppu | betoni | all | owner", allowed: [...COMPANY_TYPES] },
      { name: "notes", type: "string", description: "muistiinpanot" },
      { name: "outreach-name", type: "string", description: "Contact override name" },
      { name: "outreach-email", type: "string", description: "Contact override email" },
      { name: "outreach-phone", type: "string", description: "Contact override phone" },
      { name: "parked-until", type: "string", description: "Hold the prospect until this date (YYYY-MM-DD or today/tomorrow); " + clearHint("--parked-until") + " and lift the hold. Does NOT change --status" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success: true } · { dryRun: true, wouldUpdate: { asiakasId, fields } } on --dry-run",
    notes: [
      "--parked-until is how you defer a prospect. Do NOT park by moving --status to a terminal key: status holds ONE fact, so overwriting it destroys the pipeline position the prospect actually reached, and the row then misstates its own history. A parked row keeps its true status, reports `parked: true`, and is suppressed from `--due` until the date passes — after which it surfaces again by itself. The change is also written to the event trail. Deploy-gated: needs the 2026-08-10-jerry-onboarding-parked-until migration.",
    ],
    errors: [
      apiErr(400, "Unknown --status or --company-type, or malformed --parked-until", "use one of the status keys listed on --status; --company-type is pumppu|betoni|all|owner; --parked-until must be YYYY-MM-DD or empty (`--parked-until=` on PowerShell)"),
      TIER_PARSE_ERR,
      apiErr(404, "Prospect not found", "add it first: ib jerry admin onboarding add"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin onboarding set 1389 --status vastasi_kylla --reason "vastasi puhelimessa"'],
  },
  {
    command: "ib jerry admin onboarding events",
    description:
      "Read a prospect's contact history, newest-first (GET /api/admin/jerry-onboarding/:asiakasId/events) — the append-only trail of calls, responses, notes, status_change moves, email_sent snapshots and self_apply applications. This is where a decision's REASON lives: the prospect row carries only the current status, so a terminal status like `ei_sovellu` is indistinguishable from a deliberate hold until you read the trail. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "type", type: "string", description: "Only this event kind. call/response/note are caller-written; status_change, email_sent and self_apply are written by the backend — `--type self_apply` is how you isolate inbound applications from betonijerry.fi", allowed: [...ONBOARDING_EVENT_TYPES_ALL] },
      { name: "limit", type: "number", description: "Keep only the newest N events (sets `truncated`)" },
      { name: "full", type: "boolean", description: `Return complete emailBody snapshots instead of the ${ONBOARDING_EVENT_BODY_CAP}-char preview` },
    ],
    outputShape:
      "ListEnvelope<{ jerryOnboardingEventId, asiakasId, eventType, eventText, templateKey, emailTo, emailSubject, emailBody, eventTime, createdByPersonId, createdTime }> — `hint` names how many emailBody snapshots were cut",
    errors: [
      limitErr("pass a positive integer; this only keeps the newest N client-side and sets `truncated` — OMIT `--limit` to keep every event"),
      apiErr(400, "Invalid asiakasId", "pass a positive integer asiakasId"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      `emailBody is capped at ${ONBOARDING_EVENT_BODY_CAP} chars unless --full — one welcome-email snapshot is ~3 KB and a few of them bury the rest of the timeline. Neither reduction is silent: --limit sets "truncated", the body cut sets "hint".`,
      "eventTime is the BUSINESS time (backdatable via `onboarding note --time`); createdTime is when the row was written. They differ on any imported or backdated event, so order by eventTime when reconstructing what happened.",
    ],
    seeAlso: ["ib jerry admin onboarding note", "ib jerry admin onboarding list"],
    examples: [
      "ib jerry admin onboarding events 1414",
      "ib jerry admin onboarding events 1414 --type note",
      "ib jerry admin onboarding events 1414 --type email_sent --full",
    ],
  },
  {
    command: "ib jerry admin onboarding note",
    description:
      "Append a call/response/note event to a prospect's contact history (POST /api/admin/jerry-onboarding/:asiakasId/events). --time backdates; --set-status also moves the pipeline status (a second, best-effort step — see NOTES). To READ the history use `ib jerry admin onboarding events`. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "type", type: "string", description: "Event kind: call | response | note; REQUIRED", allowed: [...ONBOARDING_EVENT_TYPES] },
      { name: "text", type: "string", description: "Event text; REQUIRED" },
      { name: "time", type: "string", description: "Backdated event time. Offset-less (2026-08-11T12:00) = Helsinki wall-clock; a zoned form (…+03:00, …Z) is converted to that instant" },
      { name: "set-status", type: "string", description: `Also set the pipeline status. Keys: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ jerryOnboardingEventId } · { jerryOnboardingEventId, statusUpdated: false } when --set-status failed AFTER the event was written · { dryRun: true, wouldLog: { asiakasId, eventType, setStatus } } on --dry-run",
    errors: [
      apiErr(400, "Invalid eventType / missing text / unknown --set-status", "type must be call, response or note; --set-status must be a known pipeline status key. Reading the history instead? That is `ib jerry admin onboarding events <asiakasId>`"),
      { origin: "client", exit: 4, meaning: "--time is not a parseable ISO 8601 timestamp, or a component is out of range", remedy: "pass Helsinki wall-clock (2026-08-11T12:00) or a zoned form (2026-08-11T12:00:00+03:00)" },
      apiErr(404, "Prospect not found", "add it first: ib jerry admin onboarding add"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--set-status is NOT atomic with the event write: the event is inserted first, then the status update + its status_change event. If that second step fails the call still returns 200 with `statusUpdated: false` and the event already persisted — check for that key rather than assuming a 200 moved the status. A --set-status equal to the current status is a no-op (no status_change event).",
      "`ib jerry admin onboarding log` is a hidden back-compat alias for this command. It was renamed because every other `ib … log` is an audit-trail READ, so callers reached for it to read a prospect's history and got a usage error.",
      "--time is normalized to a UTC instant BEFORE the POST. An offset-less value is read as Europe/Helsinki (the timezone every date flag here documents), so `--time 2026-08-11T12:00` stores 09:00Z in summer. Until 2026-08-12 the raw string was posted and the offset was DROPPED rather than applied — `12:00:00+03:00` stored as 12:00Z, skewing every backdated event by 2-3 h with an HTTP 200 and no signal (fb#412). Onboarding events are append-only, so verify with `ib jerry admin onboarding events <asiakasId>` before relying on a backfilled timestamp.",
    ],
    seeAlso: ["ib jerry admin onboarding events"],
    examples: ['ib jerry admin onboarding note 1389 --type call --text "puhuttiin Jussin kanssa, kiinnostunut" --set-status vastasi_kylla'],
  },
  {
    command: "ib jerry admin request list",
    description:
      "System-wide tarjouspyyntö list with offer summary — date, customer, placing operator, worksite, m³, status, offer count, accepted/best price (GET /api/admin/jerry-requests). Filters: --status (CSV), --from/--to (createdAt), --customer, --provider, --limit. --provider does not only filter, it WIDENS every row with that company's own fan-out state — see OUTPUT. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: "Status CSV: draft,open,no_supply,pending_verification,accepted,cancelled,expired", allowed: [...ADMIN_REQUEST_STATUSES] },
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "customer", type: "number", description: "Customer asiakasId" },
      { name: "provider", type: "number", description: "Provider asiakasId — also WIDENS each row with that provider's own fan-out state (see OUTPUT)" },
      { name: "limit", type: "number", default: "300", description: "Max rows (max 300)" },
    ],
    outputShape:
      "ListEnvelope<{ pumppuRequestId, status, createdAt, sentAt, expiresAt, customerAsiakasId, customerNimi, operatorName, osoite, totalM3, kayttokohde, offerCount, acceptedPriceCents, bestPriceCents, sourceChannel }>. Under --provider each row ALSO carries provider: { notifiedAt, viewedAt, viewSource, viewedByPersonId, declinedAt, declineReason, offerStatus, offerPriceCents } — that one company's own fan-out state. `viewSource` is 'authenticated' | 'link' | null and is the field to read, NOT viewedAt: it separates a provider who signed in and opened the lead from somebody who clicked the tokenized link in the notification email, which viewedAt alone conflates (fb#638).",
    errors: [
      { origin: "client", exit: 4, match: "--status", meaning: "Unknown status in --status, rejected locally. The ROUTE rejects the same value with 400 since puminet5api@1.29.0 (fb#656) — this saves the round-trip, it is not a divergent contract", remedy: `use only: ${ADMIN_REQUEST_STATUSES.join(", ")}` },
      { origin: "client", exit: 4, match: ["--customer", "--provider", "--limit"], meaning: "--customer/--provider/--limit is not a positive integer, rejected locally before any request", remedy: "pass a positive integer; resolve an asiakasId with `ib company list`" },
      apiErr(400, "The route rejected a filter value. --status/--customer/--provider/--limit are all guarded locally, so in practice this is --from/--to: an unparseable date is a 400 since puminet5api@1.29.2 (fb#693, and a 500 before that), and the CLI passes any non-today/yesterday/tomorrow value through unvalidated", "pass --from/--to as YYYY-MM-DD (or today/yesterday/tomorrow)"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request stats"],
    examples: ["ib jerry admin request list --status open,accepted", "ib jerry admin request list --provider 1402 --from 2026-06-01"],
  },
  {
    command: "ib jerry admin request stats",
    description:
      "Windowed tarjouspyyntö rollup — per-bucket counts with the status split and offer summary (GET /api/admin/jerry-requests/stats). The aggregate sibling of `request list`: answers 'how many per week?' in one call instead of pulling every row and bucketing client-side. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "group-by", type: "string", default: "week", description: "Bucket by week | month | status", allowed: [...REQUEST_STATS_GROUPS] },
    ],
    outputShape:
      "{ groupBy, from, to, buckets: [{ bucket, total, byStatus: { [status]: count }, offerCount, withOffers }], totals: { total, byStatus, offerCount, withOffers } }",
    errors: [
      apiErr(400, "Invalid groupBy", "use week, month or status"),
      { origin: "client", exit: 4, match: "--group-by", meaning: "--group-by is not week/month/status", remedy: "pass one of week, month, status" },
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Bucketing happens in SQL in HELSINKI time, not UTC: a Sunday-evening request belongs to the week a Finnish reader would put it in. Weeks are ISO weeks labelled with the ISO YEAR, so a week straddling New Year stays one bucket — 2027-01-03 is `2026-W53`, not `2027-W53`.",
      "`withOffers` counts requests that received at least one non-draft offer; `offerCount` sums the offers themselves. With --group-by status the bucket IS the status, so byStatus has a single key — useful as a plain status breakdown for the window.",
      "Unlike `request list` there is no row cap, so totals stay correct as volume grows (the list caps at 300 and would silently under-count a client-side rollup).",
    ],
    seeAlso: ["ib jerry admin request list", "ib jerry admin searches funnel"],
    examples: [
      "ib jerry admin request stats --from 2026-05-01",
      "ib jerry admin request stats --from 2026-01-01 --group-by month",
      "ib jerry admin request stats --from 2026-05-01 --group-by status",
    ],
  },
  {
    command: "ib jerry admin request get",
    aliases: ["ib jerry admin request show"],
    description:
      "One request's full detail — date, customer, placing operator, worksite, m³, status, offer count, accepted/best price, plus the send-time recipient list with per-company fanout state (notified/viewed/declined/hasOffer) (GET /api/admin/jerry-requests/:id). Read `viewSource`, not `viewedAt`, to judge provider engagement: a view recorded through the tokenized preview link has no authenticated person behind it, so `viewedAt` alone counts an email-link click as a provider reading the lead (fb#638). For the offers use `ib jerry admin request offers`. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [],
    outputShape:
      "{ pumppuRequestId, status, createdAt, sentAt, expiresAt, totalM3, kayttokohde, customerAsiakasId, customerNimi, operatorName, osoite, offerCount, acceptedPriceCents, bestPriceCents, recipients: [{ asiakasId, asiakasNimi, notifiedAt, viewedAt, viewSource, viewedByPersonId, viewedByName, declinedAt, declineReason, declinedByPersonId, declinedByName, hasOffer }] }. viewSource: null = never opened · \"authenticated\" = a signed-in person opened it (viewedByPersonId/viewedByName name them) · \"link\" = opened through the tokenized preview link, nobody authenticated.",
    errors: [
      apiErr(400, "Invalid id", "pass a numeric requestId"),
      SYSADMIN_403,
      apiErr(404, "Request not found", "verify pumppuRequestId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry admin request get 41"],
  },
  {
    command: "ib jerry admin request offers",
    description:
      "All offers on one request (admin view, no PII masking): offering company, contact, price, status, scheduledAt/keikka (GET /api/admin/jerry-requests/:id/offers). System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ pumppuOfferId, providerAsiakasId, providerNimi, providerContactName, priceCents, vatPercent, status, scheduledAt, keikkaId }>",
    errors: [apiErr(400, "Invalid id", "pass a numeric requestId"), SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    examples: ["ib jerry admin request offers 41"],
  },
  {
    command: "ib jerry admin searches list",
    description:
      "Searched addresses (BetoniJerry coverage-checks) aggregated by place, with searchCount and a covered vs no_supply split — the signal for where to expand provider coverage (GET /api/admin/jerry-searches). Filters: --from/--to (createdAt), --deliverable (covered | no_supply), --search (address substring), --limit. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "deliverable", type: "string", description: "covered (deliverable at least once) | no_supply (never covered)", allowed: [...SEARCH_DELIVERABLE] },
      { name: "search", type: "string", description: "Address substring filter" },
      { name: "limit", type: "number", default: "500", description: "Max rows (max 500)" },
    ],
    outputShape:
      "ListEnvelope<{ label, osoite, formattedAddress, placeId, lat, lng, searchCount, noSupplyCount, notGeocodedCount, deliverableEver, maxProviderCount, nearestVarikkoKm, lastSearchedAt }>",
    errors: [
      limitErr("pass a positive integer; max is 500, so narrow the window with `--from` / `--to` rather than raising the cap"),
      { origin: "client", exit: 4, match: "--deliverable", meaning: "--deliverable is not covered/no_supply. Rejected locally because the server ignores an unknown value and returns the UNFILTERED list — which reads as 'every address is covered'", remedy: "pass --deliverable covered or --deliverable no_supply, or omit it for all rows" },
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      "ib jerry admin searches list --deliverable no_supply",
      "ib jerry admin searches list --from 2026-07-01 --search Vihti",
    ],
  },
  {
    command: "ib jerry admin searches funnel",
    description:
      "BetoniJerry conversion funnel over a date window (GET /api/admin/jerry-searches/funnel): top-of-funnel coverage checks, wizard step 1..5 by distinct session, claimed count, and the outcome breakdown of claimed requests by status. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
    ],
    outputShape:
      "{ coverageChecks: { total, deliverable, notDeliverable, notGeocoded }, wizard: { sessions, step1, step2, step3, step4, step5, claimed }, outcomes: { [status]: count } }",
    errors: [SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    examples: ["ib jerry admin searches funnel --from 2026-07-01 --to 2026-07-24"],
  },
  {
    command: "ib jerry admin request expire",
    description:
      "Force-expire an open/no_supply/pending_verification request (POST /api/admin/jerry-requests/:id/expire). status → expired. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'expired' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in an expirable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request expire 41 --reason "abandoned"'],
  },
  {
    command: "ib jerry admin request cancel",
    description:
      "Cancel a non-terminal, non-accepted request (POST /api/admin/jerry-requests/:id/cancel). status → cancelled. Already cancelled/expired/accepted → 409 (an accepted request has a confirmed offer/keikka and is not cancellable here). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'cancelled' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in a cancellable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request cancel 41 --reason "customer request"'],
  },
  {
    command: "ib jerry admin request resend",
    description:
      "Re-match providers and notify the NEW ones (POST /api/admin/jerry-requests/:id/resend). Safe to repeat: providers already on the recipient list keep their notifiedAt/viewedAt/declinedAt and are NOT re-emailed, so a resend with an unchanged match set is a no-op (notifiedCount 0). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'open' | 'no_supply', providerCount, notifiedCount } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    notes: [
      "providerCount = companies matching the worksite now; notifiedCount = of those, how many were newly added and emailed.",
      "Use it to reach a provider that only just became eligible — it will not spam the ones that already ignored the request.",
    ],
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in a resendable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request resend 41 --reason "uusi tarjoaja alueelle"'],
  },
  {
    command: "ib jerry admin request extend",
    description:
      "Extend a request's validity (POST /api/admin/jerry-requests/:id/extend). Sets expiresAt to now + --days (default 14, i.e. 2 weeks) or an absolute --until date; the new expiry must be in the future. An 'expired' request is reactivated to 'open'; open/no_supply/pending_verification keep their status (a no_supply request stays in Koko markkina, never Päättyneet). draft/cancelled/accepted → 409. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "days", type: "number", description: "Valid for N more days from now; mutually exclusive with --until. Omit BOTH for the backend default of 14 days" },
      { name: "until", type: "string", description: "Absolute new expiry (ISO date/datetime); mutually exclusive with --days" },
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status, expiresAt } or { dryRun: true, wouldUpdate: { pumppuRequestId, expiresAt } }",
    errors: [
      { origin: "client", exit: 4, match: "--days or --until", meaning: "--days and --until passed together", remedy: "pass exactly one, or neither for the default 14 days" },
      apiErr(400, "Bad date/days", "use a positive --days or a future --until"),
      SYSADMIN_403,
      apiErr(409, "Wrong state", "request not in an extendable state (draft/cancelled/accepted)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin request extend 32 --days 14 --reason "reactivate"'],
  },
  {
    command: "ib jerry admin request delete",
    description:
      "Delete a DRAFT request permanently (DELETE /api/admin/jerry-requests/:id). Only status='draft' rows are deletable; a non-draft or missing id returns 404. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [REASON_REQUIRED_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true } or { dryRun: true, wouldDelete: { pumppuRequestId } }",
    errors: [
      SYSADMIN_403,
      apiErr(404, "Not a draft / not found", "only status='draft' rows are deletable; non-draft or missing id → 404"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin request delete 41 --reason "cleanup draft"'],
  },
];
