// person specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, authErrors, COMMON_AUTH_ERRORS, permErrors, ASIAKAS_FLAG_ERR, TRUNCATED_NOTE, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE, PERSON_SCOPE_404_REMEDY, PERSON_SCOPE_NOTE, ROLE_NAME_CLIENT_ERROR, LIMIT_500_FLAG, OWNER_ASIAKAS_FLAG, SEARCH_ALIAS_FLAG, MERGE_DRY_RUN_FIRST_NOTE, MERGE_VALIDATE_READONLY_NOTE, PERSON_PARSE_ERR, PERSON_TARGET_ERR, PERSON_TARGET_FLAG, OTHER_TENANT_403_REMEDY } from "./shared.js";

// `person role end` + `set-dates` share one backend route (fb#2935).
const ROLE_DATES_OUTPUT =
  "{ updated: 1, asiakasPersonSettingId, startDate, endDate } | { dryRun:true, wouldUpdate:{ asiakasPersonSettingId, asiakasId, personId, personSettingTypeId, old:{ startDate, endDate }, new:{ startDate, endDate } }, validation }";
const ROLE_DATES_ERRORS: CommandSpec["errors"] = [
  PERSON_TARGET_ERR,
  PERSON_PARSE_ERR,
  ROLE_NAME_CLIENT_ERROR,
  ASIAKAS_FLAG_ERR,
  apiErr(400, "Bad date (not a date, or outside 1900–2079) or an id that is not a positive integer", "use YYYY-MM-DD or today/tomorrow"),
  apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
  apiErr(404, "The person does not hold this role on --asiakas (or the backend predates fb#2935)", "check `ib person role list <personId> --asiakas <id>`"),
  ...COMMON_AUTH_ERRORS,
];

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
        description: "Filter by role name (e.g. pumppari, asiakasAdmin, keikkaHandler)",
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
      LIMIT_500_FLAG,
      {
        name: "logged-in-since",
        type: "string",
        description: "Only people whose lastLogin is at or after this ISO date/time. Requires company admin/owner in the selected company, or sysadmin/developer. Mutually exclusive with --not-logged-in-since.",
      },
      {
        name: "not-logged-in-since",
        type: "string",
        description: "Only people whose lastLogin is before this ISO date/time, including never-active people (null). Same admin access as --logged-in-since; mutually exclusive with it.",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, phone, phoneLoginEnabled:boolean (SMS login on; the login number itself is not listed), roles:number[] (distinct roles held in the scope company; [] for an --owned non-member), lastLogin?:ISO-UTC|null (company admin/owner in the selected company or sysadmin/developer only; omitted for ordinary members) }>" + TRUNCATED_NOTE,
    errors: [
      ASIAKAS_FLAG_ERR,
      limitErr("pass a positive integer; this command caps at 500, so narrow with the company/role filters rather than raising the cap"),
      apiErr(400, "Unknown role", "use a role from @ibetoni/constants ROLE_TYPEID_BY_NAME"),
      { origin: "client", exit: 4, meaning: "Invalid ISO cutoff or both login filters supplied", remedy: "pass one of --logged-in-since or --not-logged-in-since with a real ISO date/time", match: ["--logged-in-since", "--not-logged-in-since"] },
      apiErr(400, "Invalid login cutoff", "use a real ISO date/time; the CLI converts it to UTC before sending", ["login cutoff", "mutually exclusive"]),
      apiErr(403, "Login activity requires company admin", "use a company where you are admin/owner, or a sysadmin/developer token; ordinary list access is unchanged", ["login activity requires"]),
      { origin: "client", exit: 6, meaning: "Backend response lacks login activity support", remedy: "deploy the updated backend before using the login filters" },
      ...permErrors("auth.page.person.read"),
    ],
    notes: [
      "lastLogin is the latest of person.lastLoginTime (person-wide login) and driver-app visits in the SELECTED company. Null means neither exists; driver-app visits count even without a fresh login. This is activity, not a company-specific authentication history.",
      "Cutoffs without an offset use Europe/Helsinki (date-only = local midnight); Z or explicit offsets identify an instant. Filters run before --limit. Live uncached read. Filtered results lacking lastLogin are rejected: deploy the updated backend first.",
      "This command does NOT search by name — it enumerates and filters by role/company. To find a person by name or email use `ib person search <query>` (which also accepts `--search`).",
    ],
    seeAlso: ["ib person search"],
    examples: [
      "ib person list",
      "ib person list --owned",
      "ib person list --asiakas 1349 --limit 50",
      "ib person list --asiakas 27 --role pumppari --not-logged-in-since 2026-10-15T18:30",
    ],
  },
  {
    command: "ib person get",
    aliases: ["ib person show"],
    description:
      "Get a single person by personId. In scope: a person the company OWNS or a live MEMBER of it (asiakasPerson, even when another company owns them — fb#2600); global persons (ownerAsiakasId=null) are fetchable by anyone. --asiakas scopes the read to ANOTHER company (cross-tenant; developer/admin lever) — without it the lookup is scoped to the active company and an out-of-scope personId returns 404.",
    permissions: ["auth.page.person.read"],
    args: [{ name: "personId", type: "number", description: "personId to fetch" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description:
          "Read a person owned by, or a member of, this company (cross-tenant). Requires membership of that company, or sysadmin/developer; default = active company.",
      },
    ],
    outputShape:
      "{ personId, name, email, phone, asiakasId:number|null (owner tenant, same key as `person search`; null/0 = global person — fb#1393; may differ from the scope company for a member), roles:number[] (distinct roles held in the scope company) }",
    errors: [
      ASIAKAS_FLAG_ERR,
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
      "Global persons (ownerAsiakasId=null) are included in every company's results. " +
      "A company scope matches the tenant's OWN persons and its STAFF: anyone attached via " +
      "asiakasPerson, even when owned by another company (fb#1750) — the same membership " +
      "the driver board and `ib person role list` use, so 0 hits means not at this tenant.",
    permissions: [
      "auth.page.person.read",
      "--asiakas: a company you belong to, or sysadmin/developer for any tenant",
      "--all-companies: sysadmin/developer (server-enforced)",
    ],
    args: [{ name: "query", type: "string", required: false, description: "search string (or pass --search)" }],
    flags: [
      SEARCH_ALIAS_FLAG,
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
      ASIAKAS_FLAG_ERR,
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
    command: "ib person default-company get",
    description: "Read a person's default active company (personSettings type 15, OLETUS_ADMIN_YRITYS_ID) — the company a login/impersonation lands on when none is explicitly chosen.",
    args: [{ name: "personId", type: "number", description: "personId to read" }],
    flags: [],
    outputShape: "{ personId, companyId: number|null } — companyId is null when the setting has never been written for this person",
    errors: [PERSON_PARSE_ERR, ...COMMON_AUTH_ERRORS, apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY)],
    seeAlso: ["ib person default-company set", "ib person owner"],
    examples: ["ib person default-company get 294"],
  },
  {
    command: "ib person default-company set",
    description: "Set a person's default active company (personSettings type 15, OLETUS_ADMIN_YRITYS_ID), via the same change-tracked personSql.setPersonSetting path jerryAdminSql.defaultMainContactToCompany already uses.",
    permissions: ["self, sysadmin/developer, or admin of the target person's owner company (requirePersonWriteAccess)"],
    args: [{ name: "personId", type: "number", description: "personId to update" }],
    flags: [{ name: "asiakas", type: "number", description: "asiakasId to set as this person's default active company", required: true }],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "200 text body OK on success | { dryRun:true, personId, wouldChange:{ companyId?:{from,to} } } (with --dry-run)",
    errors: [
      PERSON_PARSE_ERR,
      apiErr(403, "Not allowed to change this person's settings", "see the permissions above (self/sysadmin/admin-of-owner)"),
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Distinct from `ib person owner` (which changes the OWNING tenant) — this only picks which of a person's companies a bare login/impersonation lands on. --dry-run resolves client-side (GETs first, never POSTs) since the route has no server-side X-Dry-Run guard.",
    ],
    seeAlso: ["ib person default-company get", "ib person owner"],
    examples: ["ib person default-company set 294 --asiakas 27 --reason 'migrated away from old company'"],
  },
  {
    command: "ib person day-message-channel get",
    description: "How a driver wants the day message (personSettings 56 DAY_MESSAGE_CHANNEL, the profile control's value).",
    permissions: ["self, a colleague or admin of the person's company, or sysadmin/developer (requirePersonReadAccess)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [PERSON_TARGET_FLAG],
    outputShape: "{ personId, value:'sms'|'whatsapp'|'email'|'push'|'none_self'|'none_manual'|null } — null = none saved, the driver gets SMS",
    errors: [PERSON_TARGET_ERR, PERSON_PARSE_ERR, apiErr(403, "Not allowed to read this person (also an unknown personId; a sysadmin gets value:null instead)", "see the permissions above; check the personId"), ...COMMON_AUTH_ERRORS],
    seeAlso: ["ib person day-message-channel set", "ib message driver day-text"],
    examples: ["ib person day-message-channel get 6390", "ib person day-message-channel get --person 6390"],
  },
  {
    command: "ib person day-message-channel set",
    description: "Set (or clear) how a driver wants the day message (personSettings 56 DAY_MESSAGE_CHANNEL), the value the profile control saves.",
    permissions: ["self, sysadmin/developer, or admin of the target person's owner company (requirePersonWriteAccess)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "value", type: "string", description: "sms | whatsapp | email | push | none_self | none_manual" },
      { name: "clear", type: "boolean", description: "Remove the preference (the driver gets SMS); instead of --value" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "200 text body OK on success | { dryRun:true, personId, wouldChange:{ value?:{from,to} } } (with --dry-run)",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      { origin: "client", exit: 4, match: "--value must be one of", meaning: "--value is not one of the six values", remedy: "pass sms, whatsapp, email, push, none_self or none_manual (lowercase)" },
      { origin: "client", exit: 4, match: "exactly one of --value", meaning: "neither or both of --value and --clear", remedy: "pass --value <channel> or --clear" },
      apiErr(403, "Not allowed to change this person's settings (also an unknown personId)", "see the permissions above (self/sysadmin/admin-of-owner); check the personId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "whatsapp sends as SMS until WhatsApp exists. none_self = the driver reads betoni.online themselves, none_manual = the dispatcher messages them: the automatic sheet trigger skips both; a manual send (grid or day-send) does not. --dry-run resolves client-side (GETs, never POSTs): the route has no X-Dry-Run guard.",
    ],
    seeAlso: ["ib person day-message-channel get", "ib message driver day-send"],
    examples: ["ib person day-message-channel set 6390 --value push --reason 'driver asked'", "ib person day-message-channel set --person 6390 --clear --dry-run"],
  },
  {
    command: "ib person driver-day-push get",
    description: "Whether a driver gets tomorrow's orders as a push at 20:00 (personSettings 34 NOTIFY_DAILY_CONFIRMED, the profile switch's value).",
    permissions: ["self, a colleague or admin of the person's company, or sysadmin/developer (requirePersonReadAccess)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [PERSON_TARGET_FLAG],
    outputShape: "{ personId, enabled:boolean } — no saved row = false",
    errors: [PERSON_TARGET_ERR, PERSON_PARSE_ERR, apiErr(403, "Not allowed to read this person (also an unknown personId)", "see the permissions above; check the personId"), ...COMMON_AUTH_ERRORS],
    seeAlso: ["ib person driver-day-push set", "ib dev betomik-orderbook day-push-preview"],
    examples: ["ib person driver-day-push get 6390", "ib person driver-day-push get --person 6390"],
  },
  {
    command: "ib person driver-day-push set",
    description: "Switch a driver's 20:00 push of tomorrow's orders on or off (personSettings 34 NOTIFY_DAILY_CONFIRMED), the value the profile switch saves.",
    permissions: ["self, sysadmin/developer, or admin of the target person's owner company (requirePersonWriteAccess)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "on", type: "boolean", description: "Switch the push on" },
      { name: "off", type: "boolean", description: "Switch the push off; instead of --on" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "200 text body OK on success | { dryRun:true, personId, wouldChange:{ enabled?:{from,to} } } (with --dry-run)",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      { origin: "client", exit: 4, match: "exactly one of --on", meaning: "neither or both of --on and --off", remedy: "pass --on or --off" },
      apiErr(403, "Not allowed to change this person's settings (also an unknown personId)", "see the permissions above (self/sysadmin/admin-of-owner); check the personId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Betomik only, and only date-valid pumpparit at Betomik (27) are ever pushed (the job's pumppari rule): 'on' for anyone else is stored and shown by get, but nothing is sent. A push also needs a registered push device: the profile switch also asks the phone for push permission, this command does not, so an 'on' driver without a device is counted noDevice and gets nothing. --dry-run resolves client-side (GETs, never POSTs).",
    ],
    seeAlso: ["ib person driver-day-push get", "ib dev betomik-orderbook day-push-preview"],
    examples: ["ib person driver-day-push set 6390 --on --reason 'driver asked'", "ib person driver-day-push set --person 6390 --off --dry-run"],
  },
  {
    command: "ib person invite-login",
    description:
      "Send ONE person of the active company a login invite ('kirjautumiskutsu'): SMS when the company has HAS_SMS and the person has a textable phone that is also their SMS login number, otherwise the welcome email; neither = refused. The server fills the approved text with the first name, the company name and this week's (Helsinki Mon–Sun) non-cancelled orders. Refuses a person who has already logged in unless --force. One person per call — no batch. Same sender roles, per-sender limit, SMS day cap, smsLog row and changeTracker row as `ib message sms send` / `ib message driver send`. A REAL write (SMS is billed); --dry-run is server-side: picks the channel and returns the text, sends nothing.",
    auth: "any",
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "channel", type: "string", description: "sms | email — force a channel (default: SMS if possible, else email)" },
      { name: "no-orders", type: "boolean", description: "Leave this week's order count out of the text" },
      { name: "message", type: "string", description: "Own text instead of the template (SMS rules apply: ≤ 2 segments, no links but betoni.online / app.ibetoni.fi)" },
      { name: "force", type: "boolean", description: "Send even though the person has already logged in" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ channel:'sms'|'email', text, lastLogin:string|null, smsLogId, status:'sent', ...sms: segments, phone:'***NNNN' | email: target:'p***@domain' }. With --dry-run: { dryRun:true, channel, text, lastLogin, personId, phone+segments | target }. On 409: { error, lastLogin }. On 422: { error, smsLogId, status:'failed'|'unknown', channel }.",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      { origin: "client", exit: 4, match: "--channel must be one of", meaning: "--channel is not sms or email", remedy: "pass --channel sms or --channel email, or omit it" },
      apiErr(400, "Validation", "no textable SMS login number and no valid email; --channel sms without HAS_SMS or a login number; --message too long or with a foreign link; or you (the sender) have no email for an email invite"),
      apiErr(403, "Permission denied", "requires a sender role (asiakasAdmin/owner/editor/keikkaHandler/laskuAdmin/laskupohjaAdmin) or system admin/developer"),
      apiErr(404, "Not found", "personId is not in the active company"),
      apiErr(409, "Already logged in", "the person has logged in (body.lastLogin) — no invite needed; add --force only if they really need it again"),
      apiErr(422, "Send failed or no answer", "status 'unknown' = no provider answer, it MAY have been delivered: do NOT re-send. 'failed' = refused, fix the cause first"),
      apiErr(429, "Day cap or rate limit", "SMS day cap (try --channel email or tomorrow) or the per-sender 20/min + 200/h limit: wait"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "AI callers may send this ONLY on an explicit user request, never autonomously, with the person and channel confirmed after a --dry-run (owner ruling 2026-10-21). Deploy-gated: POST /api/sms/invite-login.",
    ],
    seeAlso: ["ib person list", "ib message driver channels", "ib message sms list"],
    examples: ["ib person invite-login 6390 --dry-run", "ib person invite-login 6390 --reason 'new driver' --idempotency-key invite-6390-20261028"],
  },
  {
    command: "ib person role list",
    description:
      "List a person's per-company roles (asiakasPersonSettings) for one asiakas — the acting company by default, `--asiakas` to target another. Role names resolved via ROLE_NAME_BY_TYPEID.",
    permissions: ["company role read on the target tenant"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person, like `person day`)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "asiakas", type: "number", description: "Target asiakasId — defaults to the acting company (the global --company <id>, else the session's active company); pass it to read another tenant's roles (fb#1783)" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasPersonSettingId, roleTypeId, role: string|null, asiakasId, startDate: string|null, endDate: string|null, active: boolean }> — expired roles are listed too; `active` = startDate <= now < endDate (null = open)",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      ASIAKAS_FLAG_ERR,
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "No --asiakas and the token has no active company to default to", remedy: "pass --asiakas <id> or --company <id>, or `ib auth switch <asiakasId>`" },
      ...permErrors("company role access on the tenant"),
    ],
    examples: ["ib person role list 5351 --asiakas 26", "ib person role list --person 5351 --asiakas 26", "ib person role list 316 --company 27"],
  },
  {
    command: "ib person role grant",
    description:
      "Grant a per-company role to a person. POST /api/asiakasPersonSettings/add/:asiakasId/:personId/:roleTypeId. Admin-gated on the tenant (tier depends on the role). --dry-run previews via the backend ({ dryRun:true, wouldCreate }).",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "role", type: "string", description: "Role name (REQUIRED), e.g. keikkaHandler, vehicleHandler, hrAdmin" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape: "{ granted: { personId, asiakasId, roleTypeId } } | { dryRun:true, wouldCreate:{ personId, asiakasId, personSettingTypeId, personSettingString }, validation }",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      ROLE_NAME_CLIENT_ERROR,
      ASIAKAS_FLAG_ERR,
      apiErr(400, "Unknown role / company limit reached", "use a name from ROLE_TYPEID_BY_NAME"),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "\"TarjousAdmin\" is NOT a usable --role value: the name denotes two different roles. laskupohjaAdmin (typeId 1) is what dbo.asiakasPersonSettingTypes + @ibetoni/constants call isTarjousAdmin, and is what the BetoniJerry email-recipient fallback and `ib jerry admin detail`.admins read; laskuAdmin (typeId 5) is what the Jerry admin dashboard's tarjousAdminCount and the Jerry validation profile's people.tarjousAdmin check read. Granting the documented one leaves Jerry validation red with a message saying you granted nothing — pass the explicit name instead (fb#418).",
    ],
    examples: [
      "ib person role grant 5351 --role keikkaHandler --asiakas 26 --reason 'onboard handler'",
      "ib person role grant 5351 --role vehicleHandler --asiakas 26 --dry-run",
    ],
  },
  {
    command: "ib person role revoke",
    description:
      "Revoke a per-company role from a person (idempotent: { removed:0 } when absent). Resolves the grant and deletes it in ONE server-side request (DELETE /api/asiakasPersonSettings/byRole/...), reading the row straight from SQL rather than the cached role list — so { removed:0 } means genuinely absent, never a stale read reporting a revocation that did not happen (fb#1537). --dry-run previews via the backend and is the only place the resolved asiakasPersonSettingId is visible before the write.",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "role", type: "string", description: "Role name (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape:
      "{ removed: 1, asiakasPersonSettingId } | { removed: 0 } (absent) | { dryRun:true, wouldDelete:{ asiakasPersonSettingId, asiakasId, personId, personSettingTypeId }, validation }",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      ROLE_NAME_CLIENT_ERROR,
      ASIAKAS_FLAG_ERR,
      // ONE row per HTTP status — hintForError matches server errors by `http`,
      // so a second 400 row here would be dead and its remedy unreachable (fb#668).
      apiErr(
        400,
        "Unknown role, or an id that is not a positive integer",
        "use a name from ROLE_TYPEID_BY_NAME; the byRole route also validates asiakasId/personId/personSettingTypeId server-side, so pass a positive personId and --asiakas"
      ),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib person role revoke 5351 --role keikkaHandler --asiakas 26 --reason rotation"],
  },
  {
    command: "ib person role end",
    description:
      "End-date a per-company role and KEEP its history row (revoke deletes it). Sets endDate (default today) and keeps startDate. PUT /api/asiakasPersonSettings/byRole/.../dates, resolved server-side and uncached like revoke; change-tracked. --dry-run previews old → new via the backend.",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "role", type: "string", description: "Role name (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "date", type: "string", description: "End date YYYY-MM-DD or today/tomorrow (default today); `role list` shows the role inactive from that day" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape: ROLE_DATES_OUTPUT,
    errors: [
      { origin: "client", exit: 4, match: "--date must not be empty", meaning: "--date was given as an empty string", remedy: "omit --date for today, or pass a date; to clear an end date use `ib person role set-dates --end ''`" },
      ...ROLE_DATES_ERRORS,
    ],
    seeAlso: ["ib person role set-dates", "ib person role list", "ib person role revoke"],
    examples: [
      "ib person role end 6301 --role pumppari --asiakas 8 --reason 'moved to Betomik'",
      "ib person role end 6301 --role pumppari --asiakas 8 --date 2026-10-31 --dry-run",
    ],
  },
  {
    command: "ib person role set-dates",
    description:
      "Set a per-company role's start and/or end date. An omitted flag keeps that date; `\"\"` clears it (open-ended). PUT /api/asiakasPersonSettings/byRole/.../dates, resolved server-side and uncached; change-tracked. --dry-run previews old → new via the backend.",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "role", type: "string", description: "Role name (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "start", type: "string", description: "Start date YYYY-MM-DD or today/tomorrow; \"\" clears" },
      { name: "end", type: "string", description: "End date YYYY-MM-DD or today/tomorrow; \"\" clears" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape: ROLE_DATES_OUTPUT,
    errors: [
      { origin: "client", exit: 4, match: "pass --start and/or --end", meaning: "Neither date flag given", remedy: "pass --start <date>, --end <date>, or both" },
      ...ROLE_DATES_ERRORS,
    ],
    seeAlso: ["ib person role end", "ib person role list"],
    examples: [
      "ib person role set-dates 6301 --role pumppari --asiakas 27 --start 2026-11-01 --reason 'starts at Betomik'",
      "ib person role set-dates 6301 --role pumppari --asiakas 8 --end '' --reason 'reopen role'",
    ],
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
      OWNER_ASIAKAS_FLAG,
      LIMIT_500_FLAG,
      { name: "field", type: "string", description: "Filter by changeTracker fieldName (e.g. asiakasPersonSetting for role changes)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, field, oldValue, newValue, changeType, personId, personName, at, description, reason }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit to reach older rows (`--field` only narrows the page you already fetched)"),
      apiErr(403, "Not a member of that company (and not admin)", OTHER_TENANT_403_REMEDY)
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
      apiErr(403, "Not permitted on this tenant", OTHER_TENANT_403_REMEDY),
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
      OWNER_ASIAKAS_FLAG,
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
      apiErr(400, "Day-row vehicle conflict (errorNumber 50203): both persons drive DIFFERENT vehicles on the same day; conflictingFields lists each day as personPvm@YYYY-MM-DD with both vehicleIds", "fix those day rows first (ib person day clear / ib vehicle driver assign), then re-run --dry-run", "eri ajoneuvo"),
      apiErr(403, "Not permitted on this tenant", OTHER_TENANT_403_REMEDY),
      apiErr(404, "One or both persons not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MERGE_DRY_RUN_FIRST_NOTE,
      MERGE_VALIDATE_READONLY_NOTE,
      "Affects keikka / vehicle / tyomaa / asiakas / betoni / tuote rows and the change history; caches are invalidated server-side; a pre-merge snapshot is written to the person combinator audit log.",
      "personPvm collision: the data-carrying row wins, the empty filler is dropped, main wins ties; vehicle defaultKuski is re-pointed.",
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
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "from", type: "date", description: "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "End date YYYY-MM-DD (default: --from)" },
    ],
    outputShape: "ListEnvelope<{ personPvmId, date, statusId, status, pois, vehicleId, text }>",
    errors: [PERSON_TARGET_ERR, PERSON_PARSE_ERR, ...COMMON_AUTH_ERRORS],
    notes: [
      "Scoped to the active company (same-tenant).",
      "`status` is the personPvmStatus code; map statusId→friendly name via `ib person day statuses`.",
    ],
    seeAlso: ["ib person day set", "ib vehicle driver who"],
    examples: ["ib person day get 555 --from today", "ib person day get --person 555 --from 2026-06-01 --to 2026-06-30"],
  },
  {
    command: "ib person day set",
    description: "Set a person's day availability status (vacation/sick/free/…) for one day (--date) or a range (--from/--to). Requires --reason unless --dry-run.",
    auth: "any",
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "date", type: "date", description: "One day YYYY-MM-DD (or today/yesterday/tomorrow); or use --from/--to" },
      { name: "from", type: "date", description: "Range start (instead of --date); at most 186 days per call" },
      { name: "to", type: "date", description: "Range end, inclusive (default: --from)" },
      { name: "weekdays-only", type: "boolean", description: "Range only: skip Sat/Sun and days already holding a vakioVapaa status (holiday)" },
      { name: "status", type: "string", description: "personPvmStatusId or status name (see `ib person day statuses`)", required: true },
      { name: "text", type: "string", description: "Free-text note on the day row" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape:
      "--date: personPvm save result | { dryRun:true, personId, date, wouldChange:{ status?, text? } }. --from: { personId, from, to, statusId, set[], unchanged[], skipped[{date,reason}], count } | { dryRun:true, …, wouldChange[{ date, status, text? }], count }",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      { origin: "client", exit: 4, match: "pass either --date", meaning: "neither or both of --date / --from given", remedy: "one day: --date; a range: --from [--to]" },
      { origin: "client", exit: 4, match: "per call", meaning: "range longer than 186 days", remedy: "split the range into several calls" },
      apiErr(400, "Missing --reason or unknown/ambiguous --status", "supply --reason; check `ib person day statuses`"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced) — Keikka Handler is NOT sufficient.",
      "--status accepts an id or a name (resolved via `ib person day statuses`).",
      "--reason required unless --dry-run (exit 4).",
      "Read-merges the existing row so a re-set updates in place (no duplicate) and PRESERVES the existing vehicle assignment. It cannot CHANGE the vehicle — use `ib vehicle driver assign` for that (atomic).",
      "Range: days already at the target status+text are `unchanged` (no write), so re-running after a mid-range failure resumes. --idempotency-key is suffixed `:<date>` per day.",
    ],
    seeAlso: ["ib person day statuses", "ib person day status create", "ib person day clear", "ib vehicle driver assign"],
    examples: [
      "ib person day set --person 555 --date tomorrow --status loma --reason 'kesäloma'",
      "ib person day set --person 555 --date 2026-06-10 --status 2 --dry-run",
      "ib person day set 6381 --from 2026-10-29 --to 2027-01-28 --status Sairasloma --weekdays-only --reason 'sairasloma 3 kk'",
    ],
  },
  {
    command: "ib person day status create",
    description: "Create a day-status type, such as Sairasloma, owned by the active company. Requires --reason unless --dry-run.",
    permissions: ["Admin or HR Admin on the active company (server-enforced)"],
    flags: [
      { name: "name", type: "string", description: "Display name (personPvmStatusName)", required: true },
      { name: "code", type: "string", description: "Status text (personPvmStatus); default: --name" },
      { name: "description", type: "string", description: "Longer description" },
      { name: "pois", type: "number", description: "1 = an absence (default), 0 = present" },
      { name: "vakio-vapaa", type: "number", description: "1 = standard day off (weekend/holiday), default 0" },
      { name: "style", type: "string", description: "CSS colour for the calendar cell" },
      { name: "prefix", type: "string", description: "Letter shown in the cell (max 2 chars)" },
      { name: "active", type: "number", description: "1 = selectable (default), 0 = hidden" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape: "{ statusId, code, name, pois, vakioVapaa, description, prefix, style, active, ownerAsiakasId } | { dryRun:true, wouldCreate } (with --dry-run)",
    errors: [
      { origin: "client", exit: 4, match: "--name is required", meaning: "no --name given", remedy: "pass --name" },
      { origin: "client", exit: 4, match: "must be", meaning: "--pois/--vakio-vapaa/--active is not 0 or 1", remedy: "pass 0 or 1" },
      { origin: "client", exit: 4, match: "--prefix is at most", meaning: "--prefix is over 2 characters", remedy: "shorten --prefix to 1–2 characters" },
      apiErr(400, "A field is longer than its column (name/code 50, description/style 500 chars)", "shorten the named field", "is at most"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: ["The owner is always the active company (`ib auth switch` to change it)."],
    seeAlso: ["ib person day statuses", "ib person day status update", "ib person day set"],
    examples: ["ib person day status create --name Sairasloma --prefix S --pois 1 --reason 'uusi poissaolotyyppi'"],
  },
  {
    command: "ib person day status update",
    description: "Edit a day-status type by id; only the given flags change. Requires --reason unless --dry-run.",
    permissions: ["Admin or HR Admin on the active company; global statuses (ownerAsiakasId null): system admin/developer only (server-enforced)"],
    args: [{ name: "statusId", type: "number", required: true, description: "personPvmStatusId (see `ib person day statuses --full`)" }],
    flags: [
      { name: "name", type: "string", description: "Display name (personPvmStatusName)" },
      { name: "code", type: "string", description: "Status text (personPvmStatus)" },
      { name: "description", type: "string", description: "Longer description" },
      { name: "pois", type: "number", description: "1 = an absence, 0 = present" },
      { name: "vakio-vapaa", type: "number", description: "1 = standard day off (weekend/holiday)" },
      { name: "style", type: "string", description: "CSS colour for the calendar cell" },
      { name: "prefix", type: "string", description: "Letter shown in the cell (max 2 chars)" },
      { name: "active", type: "number", description: "1 = selectable, 0 = hidden" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape: "{ statusId, code, name, pois, vakioVapaa, description, prefix, style, active, ownerAsiakasId } | { dryRun:true, statusId, wouldChange } (with --dry-run)",
    errors: [
      { origin: "client", exit: 4, match: "statusId must be", meaning: "statusId is not a positive integer", remedy: "pass the id from `ib person day statuses --full`" },
      { origin: "client", exit: 4, match: "must be", meaning: "--pois/--vakio-vapaa/--active is not 0 or 1", remedy: "pass 0 or 1" },
      { origin: "client", exit: 4, match: "--prefix is at most", meaning: "--prefix is over 2 characters", remedy: "shorten --prefix to 1–2 characters" },
      { origin: "client", exit: 5, match: "No status", meaning: "the id is not in the active company's status list", remedy: "check `ib person day statuses --full`" },
      apiErr(400, "A field is longer than its column (name/code 50, description/style 500 chars)", "shorten the named field", "is at most"),
      apiErr(403, "Not Admin or HR Admin on the active company, or a global status (ownerAsiakasId null) without system-admin rights", "use an Admin/HR account; to change a global status, create your own with `ib person day status create`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: ["Read-merge-write: the save overwrites every column, so the current row is read first."],
    seeAlso: ["ib person day statuses", "ib person day status create"],
    examples: ["ib person day status update 41 --style orange --dry-run", "ib person day status update 41 --active 0 --reason 'ei enää käytössä'"],
  },
  {
    command: "ib person day clear",
    description: "Delete a person's day row for a date (remove status entry). Requires --reason unless --dry-run.",
    auth: "any",
    args: [{ name: "personId", type: "number", required: false, description: "personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape: "delete result | { dryRun:true, wouldDelete:{ personPvmId, date, status } | null } (with --dry-run)",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      apiErr(400, "Missing --reason", "supply --reason"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced).",
      "--reason required unless --dry-run (exit 4).",
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
    errors: [PERSON_PARSE_ERR, ...permErrors("auth.page.grid.read")],
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
    command: "ib person app-seen",
    description:
      "Which drivers opened the Kuskit driver app (/kuski) on one day — first/last open time and open count per person from dbo.kuskiAppSeen. Tenant = the acting company (global --company <id> to ask for another).",
    permissions: ["company membership (JWT-bound tenant)"],
    flags: [
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
    ],
    outputShape: "ListEnvelope<{ personId, name, date, firstSeenAt, lastSeenAt, opens }>",
    errors: [
      apiErr(400, "date must be a real YYYY-MM-DD calendar date", "pass --date YYYY-MM-DD or today/yesterday/tomorrow"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Read-only. Operator previews run on impersonation tokens and never write a stamp, so a row means the driver's own device opened the app.",
      "Deploy-gated: needs the backend that ships GET /api/cli/driver/app-seen (Kuskit v1a).",
    ],
    seeAlso: ["ib person absences", "ib vehicle driver board"],
    examples: ["ib person app-seen --date today", "ib person app-seen --date 2026-09-24 --company 27"],
  },
  {
    command: "ib person activity",
    description:
      "Login / security-event / impersonation history for one person: lastLoginTime, personLog type-1 logins, SecurityEventLog rows for the person's email — all event types (SUCCESSFUL_LOGIN plus lockout/brute-force/rate-limit), each with eventType/method/ip (source once persisted) — and impersonation rows as-target and as-actor. Developer-only — the data includes IPs/emails.",
    permissions: ["developer access (isSystemAdmin or isDeveloper)"],
    tier: "developer",
    args: [{ name: "personId", type: "number", required: false, description: "person.personId (or pass --person)" }],
    flags: [
      PERSON_TARGET_FLAG,
      { name: "limit", type: "number", default: "100", description: "Max rows per list (capped at 1000)" },
      { name: "from", type: "date", description: "Start, Helsinki: YYYY-MM-DD[THH:mm] (default: end − 90 d)" },
      { name: "to", type: "date", description: "End, Helsinki, exclusive; a bare date = whole day (default: now)" },
    ],
    outputShape:
      "{ personId, email, lastLoginTime, window:{fromUtc,toUtc}, logins:[{entryTime}], securityEvents:[{eventType,method,source,ip,timestamp}], impersonations:{ asTarget:[{actorPersonId,entryTime,type,sessionId,endReason?}], asActor:[{targetPersonId,entryTime,type,sessionId,endReason?}] } }",
    errors: [
      PERSON_TARGET_ERR,
      PERSON_PARSE_ERR,
      limitErr("pass a positive integer; this command caps at 1000"),
      apiErr(400, "bad personId, or --from/--to malformed / not in order", "numeric personId; dates YYYY-MM-DD[THH:mm], --from before --to"),
      apiErr(404, "no person with that id", "check the id with `ib person get <id>`"),
      ...permErrors("developer access (isSystemAdmin or isDeveloper)"),
    ],
    notes: [
      "Developer-gated server-side and hidden from non-developer discovery.",
      "personLog type-1 counts credential logins AND token-refresh/impersonation bootstraps; cross-check securityEvents (credential-only) to tell them apart. Deploy-gated (no-op until the puminet5api backend deploys).",
    ],
    seeAlso: ["ib person log", "ib person get"],
    examples: ["ib person activity 63", "ib person activity 63 --from 2026-10-06 --to 2026-10-07"],
  },
];
