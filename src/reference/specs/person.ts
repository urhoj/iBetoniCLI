// person specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, authErrors, COMMON_AUTH_ERRORS, permErrors, TRUNCATED_NOTE, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE, PERSON_SCOPE_404_REMEDY, PERSON_SCOPE_NOTE, ROLE_NAME_CLIENT_ERROR } from "./shared.js";

export const PERSON_SPECS: CommandSpec[] = [

  // ─── person (3) ──────────────────────────────────────────────────────────
  {
    command: "ib person list",
    description:
      "List the active company's persons. By DEFAULT returns its MEMBERS (the asiakasPerson attachment — the same set as `ib customer person list`); --owned returns the persons it OWNS (person.ownerAsiakasId) instead. --asiakas <id> scopes to the MEMBERS of another company — you must belong to it, OR be a sysadmin/developer (who may target any tenant). Optional --role uses ROLE_NAME_BY_TYPEID from @ibetoni/constants.",
    permissions: ["auth.page.person.read"],
    flags: [
      {
        name: "role",
        type: "string",
        description: "Filter by role name (e.g. driver, admin, laskuAdmin)",
      },
      {
        name: "asiakas",
        type: "number",
        description:
          "Scope to the MEMBERS of this asiakasId instead of the active company (you must belong to it, or be a sysadmin/developer). Combine with --owned for the persons it owns.",
      },
      {
        name: "owned",
        type: "boolean",
        description:
          "List persons the company OWNS (person.ownerAsiakasId) instead of its asiakasPerson members (the default).",
      },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, roles:number[] }>" + TRUNCATED_NOTE,
    errors: [
      limitErr("pass a positive integer; this command caps at 500, so narrow with the company/role filters rather than raising the cap"),
      apiErr(400, "Unknown role", "use a role from @ibetoni/constants ROLE_TYPEID_BY_NAME"),
      ...permErrors("auth.page.person.read"),
    ],
    notes: [
      "This command does NOT search by name — it enumerates and filters by role/company. To find a person by name or email use `ib person search <query>` (which also accepts `--search`).",
    ],
    seeAlso: ["ib person search"],
    examples: [
      "ib person list",
      "ib person list --owned",
      "ib person list --asiakas 1349 --limit 50",
    ],
  },
  {
    command: "ib person get",
    aliases: ["ib person show"],
    description:
      "Get a single person by personId. Global persons (ownerAsiakasId=null) are fetchable by anyone. --asiakas reads a person owned by ANOTHER company (cross-tenant; developer/admin lever) — without it the lookup is scoped to the active company and a foreign personId returns 404.",
    permissions: ["auth.page.person.read"],
    args: [{ name: "personId", type: "number", description: "personId to fetch" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description:
          "Read a person owned by this company (cross-tenant). Requires membership of that company, or sysadmin/developer; default = active company.",
      },
    ],
    outputShape:
      "{ personId, name, email, phone, roles:number[] }",
    errors: [
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      // `match` is load-bearing, not decoration: permErrors below contributes a
      // second 403 row and neither carries a match, so `matchHttpRow` would fall
      // back to the FIRST matchless row and answer every 403 with this one —
      // making the auth.page.person.read remedy unreachable (fb#485 mechanism).
      apiErr(
        403,
        "Not a member of the --asiakas company",
        "cross-tenant person reads need membership of the target company, or sysadmin/developer. Check what you can reach with `ib company list`.",
        ["not a member of asiakas", "cross-company person"]
      ),
      ...permErrors("auth.page.person.read"),
    ],
    notes: [PERSON_SCOPE_NOTE],
    seeAlso: ["ib customer person list", "ib person search"],
    examples: ["ib person get 6233", "ib person get 6300 --asiakas 1380"],
  },
  {
    command: "ib person search",
    description:
      "Free-text search across person names / emails. POST /api/person/search. " +
      "Scoped to your active company. Four mutually exclusive scopes: (default) the " +
      "active company; --asiakas <id> one OTHER company; --my-companies every company " +
      "you belong to, in one server-side call (with a per-company client-sweep fallback " +
      "if that endpoint isn't deployed yet); --all-companies EVERY tenant " +
      "(developer/sysadmin only). --my-companies and --all-companies return one flat " +
      "list tagged with the asiakasId/name of each hit. " +
      "Global persons (ownerAsiakasId=null) are included in every company's results.",
    permissions: [
      "auth.page.person.read",
      "--asiakas: a company you belong to, or sysadmin/developer for any tenant",
      "--all-companies: sysadmin/developer (server-enforced)",
    ],
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
        name: "asiakas",
        type: "number",
        description:
          "Search this asiakasId instead of your active company (cross-tenant; any tenant for sysadmin/developer)",
      },
      {
        name: "my-companies",
        type: "boolean",
        description:
          "Search across all companies you belong to; each hit carries its asiakasId/asiakasName",
      },
      {
        name: "all-companies",
        type: "boolean",
        description:
          "Search EVERY tenant, no owner filter (developer/sysadmin only); each hit carries its asiakasId/asiakasName",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, phone, asiakasId }>. " +
      "With --my-companies / --all-companies each row also carries asiakasName, and the envelope gains truncated:true when the result hit the limit (backend ≥ 2026-06-11).",
    notes: [
      "The scope flags are mutually exclusive (exit 4) — they name three different result sets, so no precedence rule is applied.",
      "--all-companies is DEPLOY-GATED on GET /api/cli/person/search/global; a 404 there means the backend predates it. It has no client-side fallback on purpose: a global sweep cannot be synthesized from your own memberships, and a narrower result would read as complete.",
      "--all-companies is an unindexed cross-tenant scan (IX_person_owner is a tenant-first index), so it is bounded server-side by --limit. Prefer --asiakas <id> when you know the company.",
    ],
    errors: authErrors(
      limitErr("pass a positive integer; this is a search cap (default 50), so narrow the search term rather than raising it"),
      // ONE 403 row on purpose. Splitting the three causes used to leave two
      // permanently unreachable, because hintForError served the FIRST row at a
      // status (the dead-row trap of feedback #280/#289). Splitting is now
      // possible if each row carries a `match` substring (fb#485) — but the
      // backend returns the same generic 403 text for all three causes, so there
      // is nothing to match on. The combined remedy stays the honest answer.
      apiErr(
        403,
        "Permission denied (page permission, or no access to the requested scope)",
        "check auth.page.person.read; --asiakas on another tenant and --all-companies additionally require sysadmin/developer"
      ),
      apiErr(
        404,
        "--all-companies route not deployed on this backend",
        "check `ib version`; drop --all-companies and use --asiakas <id> or --my-companies meanwhile"
      )
    ),
    examples: [
      "ib person search 'Matti'",
      "ib person search 'Ikonen' --my-companies",
      "ib person search 'Jerry' --asiakas 1349",
      "ib person search 'Ikonen' --all-companies --limit 100",
    ],
  },
  {
    command: "ib person role list",
    description:
      "List a person's per-company roles (asiakasPersonSettings) for a given asiakas. Role names resolved via ROLE_NAME_BY_TYPEID.",
    permissions: ["company role read on the target tenant"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasPersonSettingId, roleTypeId, role: string|null }>",
    errors: permErrors("company role access on the tenant"),
    examples: ["ib person role list 5351 --asiakas 26"],
  },
  {
    command: "ib person role grant",
    description:
      "Grant a per-company role to a person. POST /api/asiakasPersonSettings/add/:asiakasId/:personId/:roleTypeId. Admin-gated on the tenant (tier depends on the role). --dry-run previews via the backend ({ dryRun:true, wouldCreate }).",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "role", type: "string", description: "Role name (REQUIRED), e.g. keikkaHandler, vehicleHandler, hrAdmin" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ granted: { personId, asiakasId, roleTypeId } } | { dryRun:true, wouldCreate:{ personId, asiakasId, personSettingTypeId, personSettingString }, validation }",
    errors: [
      ROLE_NAME_CLIENT_ERROR,
      apiErr(400, "Unknown role / company limit reached", "use a name from ROLE_TYPEID_BY_NAME"),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "\"TarjousAdmin\" is NOT a usable --role value: the name denotes two different roles. laskupohjaAdmin (typeId 1) is what dbo.asiakasPersonSettingTypes + @ibetoni/constants call isTarjousAdmin, and is what the BetoniJerry email-recipient fallback and `ib jerry admin detail`.admins read; laskuAdmin (typeId 5) is what the Jerry admin dashboard's tarjousAdminCount and the Jerry validation profile's people.tarjousAdmin check read. Granting the documented one leaves Jerry validation red with a message saying you granted nothing — pass the explicit name instead (fb#418).",
    ],
    examples: [
      "ib person role grant 5351 --role keikkaHandler --asiakas 26 --reason 'onboard handler'",
      "ib person role grant 5351 --role vehicleHandler --asiakas 26 --reason preview --dry-run",
    ],
  },
  {
    command: "ib person role revoke",
    description:
      "Revoke a per-company role from a person (idempotent: { removed:0 } when absent). Looks up the asiakasPersonSettingId then DELETEs it. --dry-run previews via the backend ({ dryRun:true, wouldDelete }).",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "role", type: "string", description: "Role name (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: 1 } | { removed: 0 } (absent) | { dryRun:true, wouldDelete:{ asiakasPersonSettingId }, validation }",
    errors: [
      ROLE_NAME_CLIENT_ERROR,
      apiErr(400, "Unknown role", "use a name from ROLE_TYPEID_BY_NAME"),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib person role revoke 5351 --role keikkaHandler --asiakas 26 --reason rotation"],
  },
  {
    command: "ib person role explain",
    description:
      "Explain a role NAME: its asiakasPersonSettingTypeId, human display name, the access tiers it grants (anyAdmin/anyWorker/anyViewer/laskuRead/requestOffer/adminCompanySelection), and whether it is deprecated — all from @ibetoni/constants. Enriched with the LIVE DB `description` (internal flag name, e.g. isAsiakasAdmin) and `comment` (rich Finnish text) read from GET /api/asiakasPersonSettings/getAllTypes, so the prose never drifts from dbo.asiakasPersonSettingTypes. Requires auth (any logged-in user); description/comment are null for roles the endpoint omits (soft-deleted pumppuHandler/Viewer). Use it to disambiguate the role names accepted by `person role grant/revoke` and `customer person list --role`.",
    auth: "any",
    args: [{ name: "name", type: "string", description: "role name (e.g. asiakasAdmin, keikkaHandler, lomaseurannassa)" }],
    flags: [],
    outputShape: "{ role, typeId, displayName: string|null, description: string|null, comment: string|null, tiers: string[], deprecated: boolean }",
    errors: [
      ROLE_NAME_CLIENT_ERROR,
      apiErr(400, "Unknown role name", "see ROLE_TYPEID_BY_NAME in @ibetoni/constants"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib person role grant", "ib person role revoke", "ib customer person list"],
    examples: ["ib person role explain asiakasAdmin", "ib person role explain lomaseurannassa"],
  },
  {
    command: "ib person me",
    description:
      "Your own profile, your roles aggregated across all your companies, and the companies you can act on. Derives identity from the JWT (works with IB_TOKEN). For the roles scoped to a single company, use `person role list --asiakas`.",
    auth: "any",
    flags: [],
    outputShape:
      "{ personId, name, email, phone, activeCompany:{asiakasId,name}, tier:'developer'|'admin'|'standard', roles:[{roleTypeId,role}], companies:[{asiakasId,name,current}], impersonating?:{actorPersonId,sessionId} } — `tier` is the capability/discovery gate (the MCP-reachable equivalent of `auth whoami`'s tier); `impersonating` present only when acting as another person.",
    errors: [...COMMON_AUTH_ERRORS],
    examples: ["ib person me", "ib person me --pretty"],
  },
  {
    command: "ib person companies",
    description:
      "List the companies (asiakkaat) a person belongs to, in the notion backend AUTHORIZATION uses: every company with an asiakasPerson attachment (or where the person is the asiakas contact person), which is the same set that mints the JWT `asiakasesWithTypes` claim. Each row carries the roles + toimittaja flags held there and `activeMembership` (does the person also hold an enabled, in-validity role?). personId defaults to the caller. Reverse of `customer person list`.",
    auth: "any",
    permissions: ["self, company admin (asiakasAdmin/hrAdmin/asiakasOwner) in a company shared with the target, or developer"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (defaults to caller)" }],
    flags: [
      {
        name: "as-token",
        type: "boolean",
        description:
          "Report the ACTIVE token's own `asiakasesWithTypes` claim verbatim instead of querying — literally what the backend authorizes on. Offline; self-only (a token carries only its bearer's memberships).",
      },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, roles: string[]|null, isTyomaaAsiakas, isPumppuToimittaja, isBetoniToimittaja, isLattiaToimittaja (each boolean|null), activeMembership }> + { personId, source: 'asiakas_listForPerson'|'person_getUserAsiakasList', hint? }. " +
      "With --as-token: ListEnvelope<{ asiakasId, roles, is*Toimittaja, isTyomaaAsiakas }> + { personId, source:'jwt-claim', mintedAt: string|null, hint } — no company names (the JWT carries none for non-active companies).",
    notes: [
      "`activeMembership: false` means AUTHORIZED but holding no live role there — still a company the backend lets the person act in. Do not read it as 'not a member'.",
      "Two membership notions exist in the DB and they disagree by design: `asiakas_listForPerson` (this command, and the JWT claim) counts any attachment; `person_getUserAsiakasList` additionally requires an undeleted attachment with an enabled, in-validity role and is always a SUBSET. Before fb#395 this command reported the subset while every authorization path read the superset.",
      "`--as-token` is the ground truth for 'why did that endpoint 403 me': provider routes (e.g. tarjous/pumppu endpoints) resolve their toimittaja flags straight from this claim. It is a SNAPSHOT taken at `mintedAt` — a company added or role granted since is absent until the token is re-minted (`ib company switch`, re-login, refresh). `mintedAt` is null on compact/short-shape tokens (signed without `iat`); treat null as unknown, not as just-now.",
      "`source: 'person_getUserAsiakasList'` means the backend route is not deployed yet, so the rows are the narrower ACTIVE-membership subset and `roles`/`is*` come back **null** — meaning 'this source cannot report them', NOT 'no roles'. Every row that source returns provably holds at least one role. The `hint` field says so too.",
    ],
    seeAlso: ["ib company list", "ib person me", "ib person role list", "ib customer person list"],
    errors: authErrors(
      apiErr(
        403,
        "Not authorized to read that person's companies",
        "you need company admin in a company you share with them, or developer access; drop the personId to read your own"
      ),
      {
        origin: "client",
        exit: 4,
        // `match` is load-bearing: without it this row becomes the exit-only
        // fallback for EVERY client-side exit 4 on this command, and would serve
        // this remedy for the unrelated "could not resolve personId from the
        // active token" failure (feedback #289 / #305 class).
        match: "--as-token",
        meaning: "--as-token given with another person's personId",
        remedy: "--as-token only reports YOUR token's claim — drop the personId, or drop --as-token to query the backend",
      }
    ),
    examples: [
      "ib person companies",
      "ib person companies 5351",
      "ib person companies --as-token",
    ],
  },
  {
    command: "ib person log",
    description:
      "Change-tracker audit trail for one person — who changed what, when, with the `--reason` recorded by every write. INCLUDES role grants/revokes (fieldName 'asiakasPersonSetting', e.g. 'Rooli lisätty: asiakasAdmin (Asiakas Admin)'); pass `--field asiakasPersonSetting` to see only role changes. GET /api/changes/person/:personId/:ownerAsiakasId; owner defaults to the active company. --field filters client-side.",
    auth: "any",
    args: [{ name: "personId", type: "number", description: "personId whose audit trail to fetch" }],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by changeTracker fieldName (e.g. asiakasPersonSetting for role changes)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, field, oldValue, newValue, changeType, personId, personName, at, description, reason }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit to reach older rows (`--field` only narrows the page you already fetched)"),
      apiErr(403, "Not a member of that company (and not admin)", "ib company switch to that owner, or use an admin token")
    ),
    examples: ["ib person log 63", "ib person log 63 --field asiakasPersonSetting", "ib person log 63 --owner 27 --limit 50"],
  },
  {
    command: "ib person duplicates",
    description:
      "List likely-duplicate person pairs for one tenant: same normalized phone (high), same email (high), or same first+last name (medium). Both rows must be older than 1 month. Read-only; admin gated server-side. Owner defaults to your active company; --owner scans another tenant. Feeds `ib person merge`.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId to scan (default: active company; a non-integer value exits 4 client-side)" },
      { name: "unowned", type: "boolean", description: "Scan the UNOWNED class instead — persons whose ownerAsiakasId is 0 or NULL (self-registrations, imports, pre-ownership rows). System admin only; mutually exclusive with --owner (fb#849)" },
    ],
    outputShape:
      "{ items: [{ id1, name1, id2, name2, matchCode: 'phone'|'email'|'full_name', matchValue, confidence: 'high'|'medium' }], count, truncated? } — truncated=true when capped at 100 pairs",
    errors: [
      apiErr(400, "ownerAsiakasId missing/invalid", "pass --owner <id>, or set an active company"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "full_name is a medium-confidence heuristic (identical first+last name) — a human confirms before merging.",
      "Each pair is returned once (id1 < id2), top 100 by confidence.",
    ],
    seeAlso: ["ib person merge", "ib person get"],
    examples: ["ib person duplicates", "ib person duplicates --owner 1349", "ib person duplicates --unowned"],
  },
  {
    command: "ib person merge",
    description:
      "Merge two duplicate persons: the secondary's references (keikka / vehicle / tyomaa / asiakas / betoni / tuote) move onto the main, then the secondary is DELETED. IRREVERSIBLE and admin gated; every merge is audited server-side. --dry-run runs the read-only /validate safety check (what would move + conflicts) and NEVER merges. A real merge requires --reason.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "main", type: "number", description: "personId to KEEP — references merge into this one (required)" },
      { name: "secondary", type: "number", description: "personId to REMOVE — merged away then deleted (required)" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "unowned", type: "boolean", description: "Merge within the UNOWNED class — BOTH persons must have ownerAsiakasId 0 or NULL (self-registrations, imports, pre-ownership rows: where duplicates actually accumulate). System admin only; mutually exclusive with --owner (fb#849)" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    reasonDetail: "(person merge is irreversible; --dry-run previews via /validate)",
    dryRunKind: "client",
    outputShape:
      "real: { success, safetyValidation, timestamp, ... } | dry-run: { dryRun: true, validation: { success, ... } }",
    errors: [
      apiErr(400, "Validation failed (missing/equal ids, or safety check)", "check --main/--secondary; run --dry-run first"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      apiErr(404, "One or both persons not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.",
      "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.",
      "Affects keikka / vehicle / tyomaa / asiakas / betoni / tuote rows and the change history; caches are invalidated server-side; a pre-merge snapshot is written to the person combinator audit log.",
      "Both persons must share one owner class: a tenant id, or (--unowned) the unowned class where owner 0 and NULL count as equal. Deploy-gated: an older backend 400s on --unowned.",
    ],
    seeAlso: ["ib person duplicates", "ib person delete"],
    examples: [
      "ib person merge --main 6001 --secondary 6002 --dry-run",
      "ib person merge --main 6001 --secondary 6002 --reason 'dedupe: same phone'",
      "ib person merge --main 10 --secondary 27 --unowned --dry-run",
    ],
  },
  {
    command: "ib person day statuses",
    description: "List the day-status types (vacation/sick/free/…) for the active company",
    auth: "any",
    flags: [
      { name: "full", type: "boolean", description: "Include prefix/style/description/active/ownerAsiakasId" },
    ],
    outputShape: "ListEnvelope<{ statusId, code, name, pois, vakioVapaa }>; with --full also { description, prefix, style, active, ownerAsiakasId }",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "Use to map a status name to its id for `ib person day set --status`.",
      "pois=true marks an absence (vacation/sick); statuses are company-configurable.",
    ],
    seeAlso: ["ib person day set", "ib person absences"],
    examples: ["ib person day statuses", "ib person day statuses --pretty", "ib person day statuses --full"],
  },
  {
    command: "ib person day get",
    aliases: ["ib person day show"],
    description: "List a person's day rows (status / vehicle / text) over a date range",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "from", type: "date", description: "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "End date YYYY-MM-DD (default: --from)" },
    ],
    outputShape: "ListEnvelope<{ personPvmId, date, statusId, status, pois, vehicleId, text }>",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "Scoped to the active company (same-tenant).",
      "`status` is the personPvmStatus code; map statusId→friendly name via `ib person day statuses`.",
    ],
    seeAlso: ["ib person day set", "ib vehicle driver who"],
    examples: ["ib person day get --person 555 --from today", "ib person day get --person 555 --from 2026-06-01 --to 2026-06-30"],
  },
  {
    command: "ib person day set",
    description: "Set a person's day availability status (vacation/sick/free/…). Requires --reason.",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "status", type: "string", description: "personPvmStatusId or status name (see `ib person day statuses`)", required: true },
      { name: "text", type: "string", description: "Free-text note on the day row" },
    ],
    writeFlags: true,
    reasonPolicy: "always",
    mutates: true,
    dryRunKind: "client",
    outputShape: "personPvm save result | { dryRun:true, personId, date, wouldChange:{ status?, text? } } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason or unknown/ambiguous --status", "supply --reason; check `ib person day statuses`"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced) — Keikka Handler is NOT sufficient.",
      "--status accepts an id or a name (resolved via `ib person day statuses`).",
      "--reason is hard-required (exits 4 without it).",
      "Read-merges the existing row so a re-set updates in place (no duplicate) and PRESERVES the existing vehicle assignment. It cannot CHANGE the vehicle — use `ib vehicle driver assign` for that (atomic).",
    ],
    seeAlso: ["ib person day statuses", "ib person day clear", "ib vehicle driver assign"],
    examples: [
      "ib person day set --person 555 --date tomorrow --status loma --reason 'kesäloma'",
      "ib person day set --person 555 --date 2026-06-10 --status 2 --dry-run --reason preview",
    ],
  },
  {
    command: "ib person day clear",
    description: "Delete a person's day row for a date (remove status entry). Requires --reason.",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
    ],
    writeFlags: true,
    reasonPolicy: "always",
    mutates: true,
    dryRunKind: "client",
    outputShape: "delete result | { dryRun:true, wouldDelete:{ personPvmId, date, status } | null } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason", "supply --reason"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced).",
      "--reason is hard-required (exits 4 without it).",
      "Resolves the personPvmId via the day list; when no row exists it's a no-op (deleted:false).",
    ],
    seeAlso: ["ib person day set", "ib person day get"],
    examples: ["ib person day clear --person 555 --date 2026-06-10 --reason 'loma peruttu'"],
  },
  {
    command: "ib person absences",
    description:
      "Staff absences (personPvm 'pois' rows — vacation / sick / etc.) in a date range. Staff-wide and person-keyed: the canonical 'who is away' query. An absent person cannot be set as a day driver, so this is also the driver-availability blocker list.",
    permissions: ["auth.page.grid.read"],
    flags: [
      { name: "from", type: "date", description: "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "End date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "person", type: "number", description: "Filter to one personId" },
    ],
    outputShape: "ListEnvelope<{ personId, name, date, status, statusName }>",
    errors: permErrors("auth.page.grid.read"),
    notes: [
      "Read-only — setting absence status is not exposed by the CLI in v1.",
      "Reuses /api/cli/driver/absences server-side; `ib vehicle driver available` already excludes these from the assignable pool. Deploy-gated.",
    ],
    seeAlso: ["ib vehicle driver available", "ib person day set"],
    examples: [
      "ib person absences --from today --to today",
      "ib person absences --from 2026-06-01 --to 2026-06-30 --person 123",
    ],
  },
  {
    command: "ib person activity",
    description:
      "Login / security-event / impersonation history for one person: lastLoginTime, personLog type-1 logins, SecurityEventLog rows for the person's email — all event types (SUCCESSFUL_LOGIN plus lockout/brute-force/rate-limit), each with eventType/method/ip (source once persisted) — and impersonation rows as-target and as-actor. Developer-only — the data includes IPs/emails.",
    permissions: ["developer access (isSystemAdmin or isDeveloper)"],
    tier: "developer",
    args: [{ name: "personId", type: "number", description: "person.personId" }],
    flags: [
      { name: "limit", type: "number", default: "100", description: "Max rows per list (capped at 1000)" },
    ],
    outputShape:
      "{ personId, email, lastLoginTime, logins:[{entryTime}], securityEvents:[{eventType,method,source,ip,timestamp}], impersonations:{ asTarget:[{actorPersonId,entryTime,type,sessionId,endReason?}], asActor:[{targetPersonId,entryTime,type,sessionId,endReason?}] } }",
    errors: [
      apiErr(400, "personId is not a positive integer", "pass a numeric personId"),
      apiErr(404, "no person with that id", "check the id with `ib person get <id>`"),
      ...permErrors("developer access (isSystemAdmin or isDeveloper)"),
    ],
    notes: [
      "Developer-gated server-side and hidden from non-developer discovery.",
      "personLog type-1 counts credential logins AND token-refresh/impersonation bootstraps; cross-check securityEvents (credential-only) to tell them apart. Deploy-gated (no-op until the puminet5api backend deploys).",
    ],
    seeAlso: ["ib person log", "ib person get"],
    examples: ["ib person activity 63", "ib person activity 63 --limit 20"],
  },
];
