/**
 * Curated short catalog summaries, keyed by full command path.
 *
 * Why this exists: the AI-chat command catalog (puminet5api
 * `modules/gpt/ib/ibCatalog.js` → `buildCatalogSystemMessage`) lists every
 * command's first-line `description`. Measured at 226 commands that prefix is
 * ~10.9k tokens, 177 lines over 80 chars. On no-cache LLM providers
 * (Mistral/Scaleway OpenAI-compat) the whole prefix is re-billed EVERY loop
 * turn — Claude API / Bedrock cache it at read-rate, so they barely notice.
 *
 * A blanket char-cap was rejected because it truncates hand-tuned behavioural
 * instructions mid-sentence. Instead, the catalog uses `summary || firstLine`:
 * a command whose first-line description exceeds ~80 chars gets a curated
 * one-liner here. `--help` and `ib reference dump`'s full `description` are
 * UNCHANGED — only the AI catalog consumes `summary`. Falling back to the
 * first line means a command without a summary is simply unaffected.
 *
 * Curation rules (so the AI can still pick the right command):
 *  - keep the discriminating essence: verb + object + the gate/scope that
 *    decides between siblings (e.g. CUSTOMER vs PROVIDER side, developer-only,
 *    LOCAL-only, weather module). Flags/detail live in `--help`.
 *  - keep it tight but USE the budget: hard cap MAX_SUMMARY_LEN = 160 (the test
 *    enforces ≤160 AND shorter-than-description). Spend it on the non-obvious
 *    "hook" (gotcha, "tool for X" routing cue, scope quirk), NOT a name
 *    restatement. Deeper business context goes in the detail tier (details.ts).
 *  - a few behavioural directives the proposal called out by name are kept
 *    verbatim-in-spirit even if slightly longer (feedback create's PROACTIVE
 *    filing; person create's --global / --get-or-create).
 *
 * Keys MUST match a real `CommandSpec.command` (enforced by
 * `test/reference/summaries.test.ts` — no orphan keys allowed).
 */

/** Max length asserted by the summaries test; keep curation honest. */
export const MAX_SUMMARY_LEN = 160;

export const COMMAND_SUMMARIES: Record<string, string> = {
  // ── ai ──────────────────────────────────────────────────────────────────
  "ib ai conversation": "Fetch a full /ai conversation transcript by id. Developer-only.",

  // ── attachment ────────────────────────────────────────────────────────────
  "ib attachment attach": "Link an existing attachment to one entity (sets that FK).",
  "ib attachment delete":
    "Soft-delete the row + IRREVERSIBLY hard-delete the Azure blob. Manager role.",
  "ib attachment detach": "Unlink an attachment from one entity (NULLs that FK). Manager role.",
  "ib attachment download":
    "Download attachment bytes to LOCAL disk. Local-only (denied on exec/MCP).",
  "ib attachment get": "One attachment: metadata + a 1h read-SAS blobUrl to fetch the bytes.",
  "ib attachment list": "List attachments linked to one entity, with group/type names.",
  "ib attachment register": "Persist attachment metadata after the bytes are in Azure (upload step 3).",
  "ib attachment search": "Search attachments in the active company, or list orphans (--missing).",
  "ib attachment types": "Attachment groups + types legend (id+name) for the --group/--type flags.",
  "ib attachment update": "Update an attachment's comment / group / type / invoice-flag (read-merge).",
  "ib attachment upload":
    "Upload a LOCAL file and link it to one entity. Local-only (denied on exec/MCP).",
  "ib attachment upload-url": "Mint a 1h write-SAS upload URL (remote-safe upload primitive).",

  // ── auth ────────────────────────────────────────────────────────────────
  "ib auth login": "Authorize this CLI via browser OAuth 2.1 + PKCE; persist credentials.",
  "ib auth logout": "Revoke the refresh token server-side and delete local credentials.",
  "ib auth refresh": "Manually refresh the JWT (auto refresh-on-401 also happens).",
  "ib auth switch": "Switch the active company; mints a new JWT bound to that tenant.",

  // ── bug ─────────────────────────────────────────────────────────────────
  "ib bug admin assign": "Assign a bug report to a developer (flips it in-progress). Developer-only.",
  "ib bug admin delete": "Permanently delete a bug report. Developer-only, IRREVERSIBLE.",
  "ib bug admin stats": "Aggregate bug-report stats (by status/severity). Developer-only.",
  "ib bug admin update":
    "Triage a bug report: status/priority/notes/resolution/assignee. Developer-only.",
  "ib bug comment": "Add a comment to a bug report; emails the other party.",
  "ib bug create": "File a bug report (LOUD: opens a GitHub issue + emails admins).",
  "ib bug get": "Fetch one bug report with its comments and attachments.",
  "ib bug list": "List bug reports (permission-filtered; admins may --owner). Newest first.",

  // ── cache ───────────────────────────────────────────────────────────────
  "ib cache clear": "Flush the entire Redis cache (cross-tenant). Developer-only; prod-guarded.",
  "ib cache entities": "List valid cache entity types + scope params. Offline, no auth.",
  "ib cache invalidate": "Invalidate cache for one entity family by domain id. Prod-guarded.",
  "ib cache pattern": "Invalidate Redis keys matching a raw glob. Developer-only; prod-guarded.",

  // ── changelog ─────────────────────────────────────────────────────────────
  "ib changelog add": "Add a dev-changelog entry (feature|improvement|bugfix). Developer-only.",

  // ── commands / discovery ──────────────────────────────────────────────────
  "ib commands":
    "Offline command discovery: domain index, a domain's list, or --all flat list. No auth.",
  "ib reference dump":
    "Emit the full command surface as JSON for AI ingestion; a domain arg narrows it.",

  // ── company ─────────────────────────────────────────────────────────────
  "ib company list": "List companies the user can act on; the active one is current:true.",
  "ib company validate": "Renamed to top-level `ib validate` — this path exits 4 with a hint.",

  // ── customer ────────────────────────────────────────────────────────────
  "ib customer create": "Create a customer (yTunnus required; --from-prh prefills from PRH).",
  "ib customer create-or-update":
    "Upsert a customer keyed by yTunnus (idempotent onboarding). Alias: upsert.",
  "ib customer log": "Change-tracker audit trail for one customer (who/what/when/reason).",
  "ib customer operator": "Verify or set the full operator preset (all 9 operator flags).",
  "ib customer person list": "List persons attached to a customer; --include-roles for full roles.",
  "ib customer prh": "Look up a company in the Finnish PRH business registry.",
  "ib customer search": "Free-text search across customer names / yTunnus / contacts.",
  "ib customer settings":
    "Report or toggle ALL asiakasSettings + pumppu. Superset of customer modules.",
  "ib customer update": "Update a customer via read-merge-write (no contact-person clobber).",
  "ib customer worksites": "List worksites belonging to a customer.",

  // ── doctor ────────────────────────────────────────────────────────────────
  "ib doctor": "Aggregated 'is my setup working' health check. Read-only.",

  // ── driver ──────────────────────────────────────────────────────────────
  "ib driver absences": "Driver absences (vacation/sick, personPvm 'pois') in a date range.",
  "ib driver assign": "Assign a day driver to a vehicle for a date (atomic; relocates prior).",
  "ib driver available": "Company pumpparit free that day (unassigned, not on leave).",
  "ib driver board": "Grid vehicles for a day with driver, gap status, and keikka load.",
  "ib driver clear": "Clear the day driver from a vehicle for a date (atomic).",
  "ib driver gaps": "Vehicles needing a driver that day (the 'Ei kuljettajaa' list).",

  // ── feedback ──────────────────────────────────────────────────────────────
  "ib feedback create":
    "File a CLI improvement/trouble report PROACTIVELY on any friction; quiet, works under --read-only.",
  "ib feedback list": "List filed CLI feedback for triage. Developer-only. Newest first.",
  "ib feedback resolve": "Triage a feedback row: set status / resolution note. Developer-only.",

  // ── help ────────────────────────────────────────────────────────────────
  "ib help": "Offline concept guides for AI users; no arg lists topics. No auth.",

  // ── jerry ───────────────────────────────────────────────────────────────
  "ib jerry admin detail":
    "Company Jerry drill-down: people/vehicles/sijainti enrolment. System-admin.",
  "ib jerry admin disable": "Disable BetoniJerry for a company (clears both flags). System-admin.",
  "ib jerry admin enable": "Enable BetoniJerry for a company (sets both flags). System-admin.",
  "ib jerry admin list": "List Jerry-active companies with per-company counts. System-admin.",
  "ib jerry admin search": "Search companies not yet Jerry-enabled (Add picker). System-admin.",
  "ib jerry check-address":
    "Geofence probe: which provider varikot cover an address. Best tool for 'no offers'.",
  "ib jerry counts": "Jerry lifecycle counts: --mine (customer) or --provider badge counts.",
  "ib jerry offer accept": "Accept an offer (CUSTOMER side); rejects siblings, accepts the request.",
  "ib jerry offer confirm": "Confirm an accepted offer (PROVIDER side).",
  "ib jerry offer create":
    "Create/update YOUR draft offer on a request (provider only); send to make it visible.",
  "ib jerry offer send": "Send a draft offer to the customer (draft → pending). Provider only.",
  "ib jerry provider-settings get": "Read a provider's Jerry settings (contact/hours/description).",
  "ib jerry provider-settings set":
    "Upsert a provider's Jerry settings (partial-safe). Returns the full saved row.",
  "ib jerry request get": "Get one pump request: customer recap, or --provider detail.",
  "ib jerry request list": "List pump requests: --mine (own) or --open (provider inbox, PII masked).",
  "ib jerry request offers": "List offers on a customer-owned request (drafts excluded).",

  // ── keikka ──────────────────────────────────────────────────────────────
  "ib keikka create": "Create a keikka (body forwarded verbatim to newKeikka).",
  "ib keikka drivers assign": "Assign the default driver to a keikka (backend picks the driver).",
  "ib keikka get": "Get one keikka by id with customer/worksite/vehicle/driver projections.",
  "ib keikka latest": "The single most recent keikka matching the filters (no date range).",
  "ib keikka list":
    "Date-windowed keikka list; --from/--to both default to today; dedupe by keikkaId (multi-worksite fan-out repeats rows).",
  "ib keikka log": "Change-tracker audit trail for one keikka (folds in keikkaBetoni rows).",
  "ib keikka search": "Search keikkas by phone / id / worksite / invoice ref. Newest first.",
  "ib keikka update": "Update a keikka; v1.0 supports only --status (numeric keikkaTilaId).",

  // ── legal ───────────────────────────────────────────────────────────────
  "ib legal accept": "Record YOUR OWN acceptance of a doc type. Developer testing aid.",
  "ib legal acceptances": "Compliance report: who accepted a doc type. Developer-only.",
  "ib legal activate": "Publish a doc version (deactivates siblings). Developer-only.",
  "ib legal active": "Roll-up of the current active document of every type.",
  "ib legal delete": "Soft-delete (deactivate) a doc version. Developer-only.",
  "ib legal save": "Create a new (immutable) doc version; --activate publishes. Developer-only.",
  "ib legal show": "Fetch the active document of a type, including markdown content.",
  "ib legal status": "Which legal docs you've accepted vs which are still missing.",
  "ib legal type create": "Create a new legal document TYPE. Developer-only.",
  "ib legal type update": "Update a legal TYPE's fields (typeName immutable). Developer-only.",
  "ib legal types": "List legal document types + their acceptance-tracking mapping.",
  "ib legal versions": "All versions of a doc type (active/draft/superseded). Content stripped.",

  // ── log ─────────────────────────────────────────────────────────────────
  "ib log by-entity-date":
    "Changes affecting deliveries DATED in a window (grid Muutoshistoria). Admin.",
  "ib log entity": "Change-tracker audit trail for one entity of any type. Admin/gated.",
  "ib log latest": "Newest changes across the active company (admin 'what just happened').",
  "ib log range": "All changes MADE within a time window (admin forensic view).",
  "ib log types": "Offline catalog of changeTracker entityTypes. No auth.",
  "ib log user": "Changes MADE BY a person (own recent, or a person's with personId).",

  // ── message board ───────────────────────────────────────────────────────
  "ib message board all": "List EVERY notice incl. expired/future (admin view). Admin/editor.",
  "ib message board create": "Create an announcement-board notice. Admin/editor.",
  "ib message board delete": "Delete a notice (admins any; editors only their own).",
  "ib message board get": "Get one notice by id (resolved client-side; needs admin/editor).",
  "ib message board list": "List notices active on a day, newest first. Any member.",
  "ib message board update": "Update a notice (GET-merges first; admins any, editors own).",

  // ── message chat ────────────────────────────────────────────────────────
  "ib message chat list": "List messages in a thread (oldest first); does NOT mark it read.",
  "ib message chat mark-read": "Mark a thread read (stamp lastReadAt to now).",
  "ib message chat send": "Send a message to a thread (recipient gets a push). Outward-facing.",
  "ib message chat thread": "Get one thread's metadata + participants.",
  "ib message chat threads": "List your message threads (inbox) with unread counts + a preview.",

  // ── message daily ───────────────────────────────────────────────────────
  "ib message daily add": "Create a daily-message box for a company (--init for own first box).",
  "ib message daily get": "One daily box's row + message + permissions (client-side over list).",
  "ib message daily grant": "Add a per-role ACL row on a shared box (defaults read-only).",
  "ib message daily list": "List a company's daily-message boxes; --date adds text + perms.",
  "ib message daily save": "Rename a box / edit its lisätieto (metadata, not message content).",
  "ib message daily set": "Write or clear a box's message for a date (broadcasts a socket).",
  "ib message daily share": "Share a box to another tenant (starts read-only).",

  // ── message support ─────────────────────────────────────────────────────
  "ib message support contact":
    "Open/append a support thread escalating a tarjous or keikka. Any user.",
  "ib message support inbox": "Support triage queue (operator escalations). Developer-only.",
  "ib message support resolve": "Mark a support thread resolved, or --reopen it. Developer-only.",

  // ── ohje (UI help text) ────────────────────────────────────────────────────
  "ib ohje get": "Get one UI help-text entry (HelperIcon content) by helpId.",
  "ib ohje list": "List every UI help-text entry (the whole helps table).",
  "ib ohje update": "Update a UI help-text entry (GET-merges; omitted fields preserved).",

  // ── person ──────────────────────────────────────────────────────────────
  "ib person companies": "List the companies a person belongs to (defaults to the caller).",
  "ib person create":
    "Create a person (--first/--last required, email optional). Supports --get-or-create and --global.",
  "ib person day set": "Set a person's day availability status (vacation/sick/free/…).",
  "ib person get": "Get one person by personId (global persons fetchable by anyone).",
  "ib person list": "List persons visible to the active company; --role filters by role name.",
  "ib person log": "Change-tracker audit trail for one person (incl. role grants/revokes).",
  "ib person me": "Your own profile + roles aggregated across all your companies.",
  "ib person owner": "Set/clear a person's owner company (--global or --asiakas).",
  "ib person role explain":
    "Explain a role name: typeId, access tiers, deprecation + live DB description.",
  "ib person role grant": "Grant a per-company role to a person. Admin-gated.",
  "ib person role list": "List a person's per-company roles for a given asiakas.",
  "ib person role revoke": "Revoke a per-company role from a person (idempotent).",
  "ib person search":
    "Free-text search persons by name/email; --my-companies spans every company you belong to.",

  // ── schedule ──────────────────────────────────────────────────────────────
  "ib schedule today": "List today's keikkas (wrapper for keikka list --from/--to today).",

  // ── schema (developer-only) ────────────────────────────────────────────────
  "ib schema dump":
    "Whole-schema structural map of dbo (tables/FKs/views/procs, no bodies). Developer-only.",
  "ib schema proc": "Signature + full T-SQL definition for one dbo proc/function. Developer-only.",
  "ib schema table": "Columns, PK, FKs and indexes for one dbo table. Developer-only.",

  // ── search ────────────────────────────────────────────────────────────────
  "ib search":
    "Cross-entity unified search (customers/worksites/persons/vehicles/keikkas/sijainnit).",

  // ── sijainti ──────────────────────────────────────────────────────────────
  "ib sijainti closest": "Find the closest sijainti of a type to a worksite (straight-line).",
  "ib sijainti create": "Create a sijainti (--name + --type required; auto-fills NOT NULL cols).",
  "ib sijainti delete": "Soft-delete a sijainti (sets deletedTime).",
  "ib sijainti distance": "Driving distance + time between two points/sijainnit (Google Maps).",
  "ib sijainti geocode": "Geocode a free-form address to coordinates (Google Maps).",
  "ib sijainti list": "List sijainnit (depots/plants/destinations); --all spans other companies.",
  "ib sijainti plants": "List concrete plants (betoniasemat) across ALL companies. Alias: tehtaat.",
  "ib sijainti set-jerry": "Enrol/unenrol a varikko in BetoniJerry (sets jerryActiveUntil).",
  "ib sijainti types": "List sijainti type categories (the 'Sijainnin laji' lookup).",
  "ib sijainti update": "Update a sijainti (--id or in --body; typed flags win).",

  // ── stats ─────────────────────────────────────────────────────────────────
  "ib stats":
    "Delivery aggregates (m³, orders); --by customer|vehicle|driver|worksite|status|day; visibility-scoped; byDriver m³ double-counts on multi-driver keikkas.",

  // ── validate ────────────────────────────────────────────────────────────────
  "ib validate": "Validate a company OR an employee against a profile (pass/fail/skip).",

  // ── vehicle ───────────────────────────────────────────────────────────────
  "ib vehicle create": "Create a vehicle (two-step new→save; ownerAsiakasId from JWT).",
  "ib vehicle driver-assign": "Assign a per-day driver to a vehicle (vehicleDriverDays).",
  "ib vehicle list": "List vehicles visible to the active company (self-describing rows).",
  "ib vehicle locations": "Fleet-wide live GPS snapshot (Ecofleet, cached 60s).",
  "ib vehicle log": "Change-tracker audit trail for one vehicle (field history).",
  "ib vehicle route": "Per-day ordered GPS track points (polyline) for a vehicle.",
  "ib vehicle search": "Search vehicles by reg-no / name / fleet-number substring.",
  "ib vehicle status": "A vehicle's current driver, current keikka, and latest GPS ping.",
  "ib vehicle timeline": "Per-day GPS timeline: named stop segments + travel legs.",
  "ib vehicle update": "Update a vehicle (read-merge-write; only provided flags change).",
  "ib vehicle visits":
    "Your fleet's visits to a worksite/sijainti (arrival/departure/duration).",

  // ── version ───────────────────────────────────────────────────────────────
  "ib version": "Local CLI version + the deployed iB build (commit SHA + slot). No auth.",

  // ── weather ─────────────────────────────────────────────────────────────
  "ib weather address": "Point forecast for a street address (geocode + FMI). Weather module.",
  "ib weather day": "Daily aggregate forecast (min/max/avg) for a lat/lng. Weather module.",
  "ib weather forecast": "Single-point FMI forecast for a lat/lng at a time (Finland only).",
  "ib weather pumping": "Hourly weather over a concrete-pumping window. Weather module.",
  "ib weather status": "Whether the weather module is enabled for the active company.",
  "ib weather toggle": "Enable/disable the weather module (--on/--off). Admin-scoped.",
  "ib weather worksite": "Forecast for a worksite (backend resolves coords from tyomaaId).",

  // ── worksite ──────────────────────────────────────────────────────────────
  "ib worksite get": "Get one worksite by id, all fields camelCase; heavy JSON blobs are opt-in.",
  "ib worksite helsinki-fetch": "Refresh Helsinki building data for a worksite.",
  "ib worksite list": "List worksites visible to the active company.",
  "ib worksite log": "Change-tracker audit trail for one worksite (field history).",
  "ib worksite metrics": "Volume / keikka-count metrics for a worksite.",
  "ib worksite search":
    "Matches all 4 address lines + contact name/phone/email, so a partial street finds the worksite. Safe under --read-only (POST sent as a read, not a write).",
  "ib worksite update": "Update a worksite (POST /api/tyomaa/set).",
};
