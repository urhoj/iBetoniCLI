// customer specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearNote, apiErr, limitErr, COMMON_AUTH_ERRORS, permErrors, LOG_CAPPED_NOTE, ASIAKAS_TARGET_FLAG } from "./shared.js";

export const CUSTOMER_SPECS: CommandSpec[] = [


  // ─── customer (12) ───────────────────────────────────────────────────────
  {
    command: "ib customer list",
    description: "List customers (asiakkaat).",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows for the unbounded list (capped at 500). Ignored when --ids is given.",
      },
      {
        name: "cursor",
        type: "string",
        description:
          "Reserved for future cursor pagination — this route has none today (nextCursor is always null); passing --cursor is a silent no-op.",
      },
      { name: "full", type: "boolean", description: "Return full customer fields + companyDescription (not just id/name/ytunnus/type)" },
      { name: "ids", type: "string", description: "Comma-separated asiakasIds to return ALL of (max 1000) — preferred for targeted/incremental fetches" },
      { name: "include", type: "string", description: "Expand each row with per-customer arrays: contacts and/or sijainnit (CSV; best with --full)" },
      { name: "fields", type: "string", description: "Project each customer to just these columns (CSV; asiakasId always kept, contacts/sijainnit arrays preserved) — cuts the diff payload" },
      { name: "sijainti-types", type: "string", description: "With --include sijainnit: keep only these sijaintiTypeId rows (CSV, e.g. 1,2) — filtered server-side so a 45-location supplier's irrelevant rows are never fetched" },
      { name: "since", type: "string", description: "Only customers registered on/after this day (YYYY-MM-DD, or today/yesterday) — 'new customers since X'. Server-side filter on the registration timestamp." },
      { name: "sort", type: "string", description: "Result ordering: name (default) or registered (newest-registered first). Server-side.", allowed: ["name", "registered"] },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, type, registeredAt }> + truncated:boolean · with --full the items add { address, postalCode, city, email, contactPersonId, shortName, comment, companyDescription, ownerAsiakasId, roolit:{isTyomaaAsiakas,isPumppuToimittaja,isBetoniToimittaja,isLattiaToimittaja} } · with --include each item adds contacts:[{personId,name,phone,email,contactPersonTypeId}] and/or sijainnit:[{sijaintiId,name,lyh,address,sijaintiTypeId,maxDeliveryDistance,jerryActiveUntil}] · with --ids the response adds missing:[{asiakasId, reason:'not_owned'|'not_found'}] for requested ids that didn't return",
    errors: [limitErr("pass a positive integer; this command caps at 500 with NO cursor pagination (nextCursor is always null, even when truncated) — narrow with --ids/--since/--sort instead of paging"), ...permErrors("auth.page.asiakas.read")],
    notes: [
      "Scope: regular users see their own tenant + their own company row; SYSTEM ADMINS list across ALL tenants (incl. cross-tenant --ids).",
      "--full returns every flat-customer field + the jerry companyDescription in one call (diff a whole tenant without N×`customer get`).",
      "--full also carries `roolit` per row, so 'which of my customers are pump providers?' is ONE call: `ib customer list --full --fields name,roolit` (needs the 2026-08-10 backend; older deployments omit the field).",
      "--ids 1,2,3 restricts to specific asiakasIds and returns ALL of them (NOT capped at the default 100 — bounded by the ids list, max 1000) — the efficient way to refresh only the rows you care about.",
      "Without --ids the list is capped (default 100 / max 500) and `truncated:true` flags the cap; nextCursor is ALWAYS null (fb#745, no true pagination) — narrow with --ids/--since instead of expecting a next page.",
      "--fields / --sijainti-types trim what you ingest: project to the columns you diff and keep only the location types you care about (e.g. varikko/asema). Server-side on a deployed backend, with a client-side fallback so they work pre-deploy.",
      "registeredAt (the customer's registration timestamp) is on every row — combine --since (e.g. --since yesterday) with --sort registered for a 'new customers in the last 24h' report, incl. cross-tenant for system admins. --since/--sort are server-side (no client-side fallback — the server truncates at --limit before any client filter could run), so they need the backend deploy.",
    ],
    examples: [
      "ib customer list",
      "ib customer list --limit 50 --pretty",
      "ib customer list --full",
      "ib customer list --ids 26,42,1349 --full",
      "ib customer list --ids 26,42 --full --include contacts,sijainnit",
      "ib customer list --ids 26 --full --fields name,address,postalCode,city,contactPersonId,companyDescription",
      "ib customer list --ids 26 --include sijainnit --sijainti-types 1,2",
      "ib customer list --since yesterday --sort registered",
    ],
  },
  {
    command: "ib customer dead-list",
    description: "List customers flagged dead/caution by the PRH nightly business-registry sweep.",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      { name: "limit", type: "number", default: "200", description: "Max rows (capped at 500)." },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, prhStatus:'dead'|'caution', prhSituation, prhCheckedAt }> — dead rows first, then most-recently-checked.",
    errors: [limitErr("pass a positive integer; this command caps at 500 and has no narrowing filter — raise --limit if you need more than the 200 default"), ...permErrors("auth.page.asiakas.read")],
    notes: [
      "Reads the prhStatus columns written by the nightly PRH sweep (puminet7) — not a live PRH lookup.",
      "Scope: own tenant; system admins see all tenants.",
      "`dead` = konkurssi/selvitystila/purettu (won't pay); `caution` = yrityssaneeraus (sell with care / prepay).",
    ],
    examples: ["ib customer dead-list", "ib customer dead-list --pretty", "ib customer dead-list --limit 50"],
  },
  {
    command: "ib customer get",
    aliases: ["ib customer show"],
    description:
      "Get a single customer (asiakas) by id: flat contact fields + roolit (what the company IS — pump/concrete/floor supplier, worksite customer).",
    permissions: ["auth.page.asiakas.read"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to fetch" }],
    flags: [],
    outputShape:
      "{ asiakasId, name, yTunnus, type, address, postalCode, city, email, phone, contactPersonId, shortName, comment, registeredAt, ownerAsiakasId, roolit:{ isTyomaaAsiakas, isPumppuToimittaja, isBetoniToimittaja, isLattiaToimittaja } }",
    errors: [
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...permErrors("auth.page.asiakas.read"),
    ],
    notes: [
      "roolit is the answer to 'what is this company?' — isPumppuToimittaja is what gates every provider-side pumppuRequest endpoint (and the frontend's jerry page), so read it rather than inferring the business from the free-text `comment`. The two DO diverge: a comment can say the pumping business was sold while isPumppuToimittaja is still true.",
      "roolit is the same sub-shape `customer modules` reports, minus the 8 module flags — those need the admin-gated read (`ib customer modules <id>`), this one only needs asiakas.read.",
      "roolit needs the 2026-08-10 backend; against an older deployment the field is simply absent (not false).",
      "ownerAsiakasId (fb#744) is this customer's tenant — do not infer it from `customer list` membership, which may include rows owned by another tenant.",
    ],
    seeAlso: ["ib customer modules", "ib customer settings", "ib customer list"],
    examples: ["ib customer get 1349"],
  },
  {
    command: "ib customer worksites",
    description: "List worksites belonging to a customer (GET /api/tyomaa/asiakasTyomaaList/:asiakasId).",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId" }],
    flags: [],
    outputShape: "ListEnvelope<{ tyomaaId, name, address, city }>",
    errors: [...permErrors("auth.page.tyomaa.read")],
    examples: ["ib customer worksites 1349"],
  },
  {
    command: "ib customer create",
    description:
      "Create a customer. Typed flags assemble the createY body (yTunnus REQUIRED); --from-prh prefills name+yTunnus+billing address from the PRH registry; --address/--postal-code/--city set the billing postal address; --body raw JSON overrides flags. Returns the flat customer shape via re-fetch.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "ytunnus", type: "string", description: "Business ID (yTunnus) — required unless --from-prh/--body supplies it" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "from-prh", type: "string", description: "Prefill name + yTunnus + billing address from PRH for this business ID" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "get-or-create", type: "boolean", description: "If a customer with this yTunnus already exists, return it (reused:true) instead of creating a duplicate" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "flat customer { asiakasId, name, yTunnus, type, address, postalCode, city, email, contactPersonId, shortName, comment } (or wouldCreate on --dry-run; with --get-or-create adds reused:boolean)",
    errors: [
      apiErr(400, "Missing yTunnus / validation, or >1 customer shares the yTunnus with --get-or-create", "pass --ytunnus or --from-prh; for an ambiguous match use `ib customer get <id>`"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer create --from-prh 0145937-9 --email billing@x.fi --reason onboard",
      "ib customer create --name 'Example Oy' --ytunnus 1234567-8",
      "ib customer create --from-prh 0145937-9 --get-or-create --reason onboard",
    ],
  },
  {
    command: "ib customer update",
    description:
      "Update a customer via read-merge-write: reads the current record, overlays the provided flags (preserving everything else — no contact-person clobber), writes back with saveGlobalAsiakas. --from-prh refreshes name+yTunnus+billing address from the registry (explicit flags still win). Billing postal address (--address/--postal-code/--city) is writable; pass an empty string to clear a field (" + clearNote("--address") + "). --body raw JSON overrides flags.",
    permissions: ["auth.page.asiakas.edit"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to update" }],
    flags: [
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "ytunnus", type: "string", description: "Business ID (ytunnus)" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "comment", type: "string", description: "Comment (kommentti)" },
      { name: "contact-person", type: "number", description: "Single PRIMARY contact personId (asiakasContactPersonId) — for memberships use `customer person add` (see docs: asiakas-contact-person-model)" },
      { name: "type", type: "number", description: "Customer type id (asiakasTypeId)" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "from-prh", type: "string", description: "Refresh name + yTunnus + billing address from PRH (explicit flags still win)" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "flat customer shape + changed:boolean|null (whether anything actually changed vs an idempotent no-op; null = undetermined) · wouldUpdate on --dry-run",
    errors: [
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer update 26 --email new@x.fi --reason 'email change'",
      "ib customer update 26 --name 'Renamed Oy'",
    ],
  },
  {
    command: "ib customer create-or-update",
    aliases: ["ib customer upsert"],
    description:
      "Upsert a customer keyed by business ID (ytunnus) — removes the search-then-create dance for idempotent onboarding. Looks the ytunnus up in your tenant (system admins: across tenants); 1 match → update (read-merge with your flags), 0 → create, >1 → error (exit 4). --from-prh <yt> uses that business ID as the key AND prefills name+yTunnus from PRH on create. Alias: `ib customer upsert`.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "ytunnus", type: "string", description: "Business ID key (yTunnus) — required unless --from-prh/--body supplies it" },
      { name: "from-prh", type: "string", description: "Use this business ID as the key AND prefill name+yTunnus+billing address from PRH on create" },
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "comment", type: "string", description: "Comment (kommentti) — applied on create or update" },
      { name: "contact-person", type: "number", description: "Contact person id — applied on update" },
      { name: "type", type: "number", description: "Customer type id — applied on update" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ...flat customer, action: 'created'|'updated' } (action 'updated' also carries changed:boolean|null) · { action: 'would-*', dryRun } on --dry-run",
    errors: [
      apiErr(400, "No ytunnus key, or >1 customers share the ytunnus (ambiguous)", "provide --ytunnus/--from-prh; for an ambiguous match use `ib customer update <id>`"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer create-or-update --from-prh 1234567-8 --reason 'PRH onboarding'",
      "ib customer upsert --ytunnus 1234567-8 --name 'Example Oy' --email billing@example.fi --reason onboard",
    ],
  },
  {
    command: "ib customer search",
    description:
      "Free-text search across customer names / yTunnus / contacts. GET /api/asiakas/search?searchString=...",
    permissions: ["auth.page.asiakas.read"],
    args: [{ name: "query", type: "string", required: false, description: "search string (or pass --search)" }],
    flags: [
      {
        name: "search",
        type: "string",
        description: "Search query (alias for the <query> positional)",
      },
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results",
      },
      {
        name: "my-companies",
        type: "boolean",
        description: "Search across every company you belong to (customer/worksite/person)",
      },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, score }>",
    errors: [limitErr("pass a positive integer; this is a search cap (default 50), so narrow the search term rather than raising it"), ...permErrors("auth.page.asiakas.read")],
    examples: ["ib customer search Example", "ib customer search 1234567"],
  },
  {
    command: "ib customer modules",
    description:
      "Report or toggle a TENANT's roolit + module flags — any asiakas you administer, your own company included (there is no `ib company modules`).",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId to report/modify (or pass --asiakas)" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description: "Target asiakasId (alias for the positional)",
      },
      {
        name: "set",
        type: "string",
        description: "Comma-separated field keys to turn ON",
      },
      {
        name: "unset",
        type: "string",
        description: "Comma-separated field keys to turn OFF",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "report: { asiakasId, roolit:{...}, modules:{...} } | write: { asiakasId, applied:{ set, unset, dryRun }, state:{ roolit, modules } }",
    errors: [
      apiErr(400, "Unknown field key, or key in both --set and --unset", "use only: pumppu/jerry/henkilot/sijainnit/ajoneuvot/tiedostot/weather/lomaseuranta/shareorders"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Field keys: pumppu (isPumppuToimittaja), jerry, henkilot, sijainnit, ajoneuvot, tiedostot, weather, lomaseuranta, shareorders.",
      "Without --set/--unset it is a read-only report (GET /api/cli/customer/modules/:asiakasId); with them it routes pumppu → POST /api/asiakas/setRoolit and modules → POST /api/asiakas/settings/save.",
      "The target accepts either the positional <asiakasId> or --asiakas <id> (same flag as the rest of customer/*); pass one — including for your own company, whose id is `ib company current`.",
    ],
    seeAlso: ["ib customer settings", "ib company current"],
    examples: [
      "ib customer modules 1349",
      "ib customer modules --asiakas 1349 --set jerry,weather,pumppu --reason 'enable operator features'",
      "ib customer modules 1349 --unset shareorders --dry-run",
    ],
  },
  {
    command: "ib customer operator",
    description:
      "Verify or provision the full operator preset — all 9 operator flags at once (pumppu + the 8 modules). Default (no flag): verify, exit 0 iff every flag is on else exit 1 (CI-gateable). --set turns all 9 on; --reset turns all 9 off. System-admin can run cross-tenant.",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId to verify/provision (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "set", type: "boolean", description: "Turn ALL 9 operator flags ON" },
      { name: "reset", type: "boolean", description: "Turn ALL 9 operator flags OFF" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "verify: { asiakasId, allSet, flags:{ pumppu, jerry, … }, missing:[…] } (exit 1 when allSet=false) | set/reset: { asiakasId, applied:{ set, unset, dryRun }, state }",
    errors: [
      apiErr(400, "--set and --reset both given", "pass at most one of --set / --reset"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      "ib customer operator 1349",
      "ib customer operator --asiakas 1349 --set --reason 'onboard operator'",
      "ib customer operator 1349 --reset --reason 'offboard operator'",
    ],
  },

  {
    command: "ib customer duplicates",
    description:
      "List likely-duplicate customer pairs for one tenant (y-tunnus / exact-name / email / name-prefix matches). Read-only; system-admin gated server-side. Owner defaults to your active company; --owner scans another tenant. Feeds `ib customer merge`.",
    permissions: ["system admin (or company admin on the target tenant)"],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId to scan (default: active company)" },
    ],
    outputShape:
      "{ items: [{ id1, name1, id2, name2, matchCode: 'ytunnus'|'exact_name'|'email'|'name_prefix', matchValue, confidence: 'high'|'low' }], count, truncated? } — truncated=true when capped at 100 pairs",
    errors: [
      apiErr(400, "ownerAsiakasId missing/invalid", "pass --owner <id>, or set an active company"),
      apiErr(403, "Not permitted on this tenant", "use a system-admin token"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "name_prefix is a low-confidence heuristic (same distinctive name-start after stripping generic lead-words like Rakennusliike / Kiinteistö Oy) — a human confirms before merging.",
      "Each pair is returned once (id1 < id2), top 100 by match confidence.",
    ],
    seeAlso: ["ib customer merge", "ib customer get"],
    examples: ["ib customer duplicates", "ib customer duplicates --owner 1349"],
  },

  {
    command: "ib customer merge",
    description:
      "Merge two duplicate customers: the secondary's references move onto the main, then the secondary is DELETED. IRREVERSIBLE and system-admin gated. --dry-run runs the read-only /validate safety check (what would move + conflicts) and NEVER merges. A real merge requires --reason.",
    permissions: ["system admin (or company admin on the target tenant)"],
    flags: [
      { name: "main", type: "number", description: "asiakasId to KEEP — references merge into this one (required)" },
      { name: "secondary", type: "number", description: "asiakasId to REMOVE — merged away then deleted (required)" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "allow-big-merge", type: "boolean", description: "System-admin: permit a merge above the safety row cap" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    reasonDetail: "(customer merge is irreversible; --dry-run previews via /validate)",
    dryRunKind: "client",
    outputShape:
      "real: { success, safetyValidation, timestamp, ... } | dry-run: { dryRun: true, validation: { success, ... } }",
    errors: [
      apiErr(400, "Validation failed (missing/equal ids, or safety row cap)", "check --main/--secondary; run --dry-run first; a system-admin may add --allow-big-merge"),
      apiErr(403, "Not permitted on this tenant", "use a system-admin token"),
      apiErr(404, "One or both customers not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.",
      "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.",
      "Affects keikka / tyomaa / person / sijainti / stat / lasku rows and the change history; caches are invalidated server-side.",
    ],
    seeAlso: ["ib customer duplicates", "ib customer delete"],
    examples: [
      "ib customer merge --main 8001 --secondary 8002 --dry-run",
      "ib customer merge --main 8001 --secondary 8002 --reason 'dedupe: same y-tunnus'",
    ],
  },

  {
    command: "ib customer log",
    description:
      "Change-tracker audit trail for one customer — who changed which field, when, and the --reason. Reads the same log the CLI's writes populate.",
    permissions: ["auth.page.asiakas.read (company member or admin)"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId" }],
    flags: [
      { name: "limit", type: "number", default: "100", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, field, oldValue, newValue, changeType, personId, personName, at, description, reason }>" +
      LOG_CAPPED_NOTE,
    errors: [limitErr("pass a positive integer; this cursor-less route caps at 500 and has no narrowing filter — raise --limit to reach older rows"), ...permErrors("auth.page.asiakas.read")],
    examples: ["ib customer log 26", "ib customer log 26 --limit 20"],
  },
  {
    command: "ib customer settings",
    description:
      "Report or toggle ALL asiakasSettings (every canonical ASIAKAS_SETTING_TYPE_IDS name) plus pumppu, for any TENANT you administer — your own company included (there is no `ib company settings`). Without --set/--unset it is a read-only report. Names are case-insensitive; the 8 module aliases (jerry, weather, …) and pumppu are also accepted. Superset of `customer modules`.",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "set", type: "string", description: "Comma-separated setting names to turn ON" },
      { name: "unset", type: "string", description: "Comma-separated setting names to turn OFF" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "report: { asiakasId, roolit:{…}, settings:{ HAS_FENNOA:bool, ALV:bool, … every setting } } | write: { asiakasId, applied:{set,unset,dryRun}, state }",
    errors: [
      apiErr(400, "Unknown setting name, or name in both --set/--unset", "use a canonical ASIAKAS_SETTING_TYPE_IDS name, an alias, or pumppu"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib customer modules", "ib company current"],
    examples: [
      "ib customer settings 1349",
      "ib customer settings --asiakas 1349 --set HAS_FENNOA,ALV --unset HAS_OCR --reason 'billing setup'",
    ],
  },
];
