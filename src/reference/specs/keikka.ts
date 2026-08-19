// keikka specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, authErrors, COMMON_AUTH_ERRORS, permErrors, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE } from "./shared.js";

export const KEIKKA_SPECS: CommandSpec[] = [

  // ─── keikka (6) ──────────────────────────────────────────────────────────
  {
    command: "ib keikka list",
    description:
      "List concrete delivery orders (keikkas) for the active company within a date range. Flat envelope optimised for AI/CI consumption.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "from",
        type: "date",
        default: "today",
        description: "Start date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "to",
        type: "date",
        default: "today",
        description: "End date (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "date",
        type: "date",
        description:
          "Single-day shorthand: sets --from and --to to this one day (YYYY-MM-DD or today/yesterday/tomorrow). Mutually exclusive with --from/--to.",
      },
      {
        name: "customer",
        type: "number",
        description: "Filter by asiakasId",
      },
      {
        name: "vehicle",
        type: "number",
        description: "Filter by vehicleId",
      },
      { name: "worksite", type: "number", description: "Filter by worksite (tyomaaId)" },
      { name: "status", type: "string", description: "Filter by tila/status" },
      {
        name: "limit",
        type: "number",
        default: "100",
        description:
          "Max rows. Omitting it sends no limit param — the backend applies the default 100 server-side (caps at 500)",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }> & { range: { from, to } } (the interpreted date window, echoed so an empty result is verifiably scoped). On an empty result the envelope also carries a `hint` explaining the count:0 (permitted-but-empty vs how to widen).",
    errors: [limitErr("pass a positive integer; this command caps at 500 — page past it with `--cursor` from the previous response's `nextCursor`, or narrow with `--from` / `--to`"), ...permErrors("auth.page.grid.tilaus.read")],
    notes: [
      "`tila` is the numeric keikkaTilaId. Legend: -1 Uusi tilaus · 0 Luonnos (draft) · 1 Kesken · 2 Lähetetty (sent) · 3 Käsittelyssä · 4 Toimitusvalmis · 5 Toimitus meneillään · 6 Toimitus epäonnistui · 7 Epäonnistui · 8 Peruttu (cancelled) · 9/12/13 Toimitettu (delivered) · 10 Poistettu (deleted) · 100 Valmis (complete) · 11/200 Järjestelmätilaus (system, do not edit).",
      "The same legend is in the GLOSSARY (`tila`) on `ib --help`; source of truth: GET /api/tila/list.",
      "A keikka spanning multiple worksites returns ONE ROW PER tyomaa (join fan-out): the same keikkaId can appear on several rows with different tyomaaId, and `count` counts ROWS, not distinct deliveries — dedupe by keikkaId when counting deliveries.",
      "Default window is TODAY only (--from/--to both default to today). A count:0 with exit 0 is a permitted query that found no data in that window — NOT an access error (denial is exit 3 / HTTP 403); the envelope's `hint` says so. Widen with --from/--to, or use `ib keikka latest` (bounded by --lookback, default 365d).",
    ],
    seeAlso: ["ib keikka latest"],
    examples: [
      "ib keikka list --from 2026-05-28 --to 2026-05-30",
      "ib keikka list --date today",
      "ib keikka list --from 2026-05-01 --to 2026-05-31 --customer 1349 --status 9 --limit 50",
      "ib keikka list --from today --to tomorrow --pretty",
    ],
  },
  {
    command: "ib keikka latest",
    description:
      "The single most recent keikka matching the filters — no date range needed. Answers 'when was the latest delivered order?' in one command by searching backwards from today.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [
      {
        name: "status",
        type: "string",
        description:
          "Filter by status (keikkaTilaId — e.g. 9 = Toimitettu; see the `tila` GLOSSARY legend)",
      },
      { name: "customer", type: "number", description: "Filter by asiakasId" },
      { name: "vehicle", type: "number", description: "Filter by vehicleId" },
      { name: "worksite", type: "number", description: "Filter by worksite (tyomaaId)" },
      {
        name: "lookback",
        type: "number",
        default: "365",
        description: "How far back from today to search, in days (max 3650)",
      },
    ],
    outputShape:
      "{ item: { keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time } | null, searched: { from, to } }",
    errors: permErrors("auth.page.grid.tilaus.read"),
    notes: [
      "Client-side windowed search over `keikka list`: walks 7/30/90/365-day windows backwards from today until a window has matches (a handful of round-trips at most). `item: null` + the `searched` range echo = genuinely nothing within --lookback.",
      "Windows truncated at the 500-row server cap are halved toward their newest end, so the true latest row cannot be hidden by truncation.",
      "Statuses 9/12/13 are all 'Toimitettu' — query the one you mean (no multi-status filter in v1).",
    ],
    seeAlso: ["ib keikka list", "ib keikka get"],
    examples: [
      "ib keikka latest",
      "ib keikka latest --status 9",
      "ib keikka latest --customer 1349 --lookback 730",
    ],
  },
  {
    command: "ib keikka get",
    description:
      "Get a single keikka by id with related customer / worksite / vehicle / driver projections.",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "keikkaId", type: "number", description: "keikkaId to fetch" }],
    flags: [],
    outputShape:
      "{ keikkaId, ownerAsiakasId, pvm, time, customer:{asiakasId,name}|null, worksite:{tyomaaId,address}|null, vehicle:{vehicleId,plate}|null, driver:{personId,name}|null, m3, status }",
    errors: [
      apiErr(404, "Keikka not found OR outside your visible scope", "verify keikkaId — but note this is NOT proof the row is absent: results mirror your permissions, so an existing keikka in another tenant 404s identically"),
      ...permErrors("auth.page.grid.tilaus.read"),
    ],
    notes: [
      "A 404 answers 'can I see it', not 'does it exist' — every command mirrors the caller's permissions, so a keikka owned by another tenant is indistinguishable from a keikkaId that was never issued. Do NOT read it as a typo. To settle existence you need a caller whose scope could see it: `ib company switch` to the owning tenant, or a system-admin/developer token (feedback #427).",
    ],
    examples: ["ib keikka get 9001"],
  },
  {
    command: "ib keikka create",
    description:
      "Create a new keikka. The body is forwarded verbatim to POST /api/keikka/newKeikka — see the backend route for required fields.",
    permissions: ["auth.page.grid.tilaus.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        required: true,
        description: "JSON object with the new keikka fields",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ keikkaId, ...echoed fields } (raw backend response)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    examples: [
      "ib keikka create --body '{\"asiakasId\":1349,\"pvm\":\"2026-06-01\"}' --reason 'manual booking'",
      "ib keikka create --body '{...}' --dry-run",
    ],
  },
  {
    command: "ib keikka update",
    description:
      "Update a keikka. v1.0 supports only `--status` (the numeric keikkaTilaId, posted to POST /api/keikka/tila/set). Other field-setters land in v1.1.",
    permissions: ["auth.page.grid.tilaus.edit"],
    args: [{ name: "keikkaId", type: "number", description: "keikkaId to update" }],
    flags: [
      {
        name: "status",
        type: "string",
        description: "New keikkaTilaId (numeric, e.g. 9 = Toimitettu)",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true } or backend response",
    errors: [
      // The THIRD twin of the fb#668 class, and the client-side shape of it:
      // this command has two exit-4 client guards but documented only one, and a
      // sole matchless client row is `matchClientRow`'s fallback — so
      // `ib keikka update <id>` with no flags was answered "pass a number, e.g.
      // --status 9", advice for a problem the caller does not have. Both rows
      // now carry a `match`, so each guard reaches its own remedy.
      { origin: "client", exit: 4, match: "nothing to update", meaning: "No field flags given at all", remedy: "pass --status <keikkaTilaId> — it is the only field v1.0 can update" },
      { origin: "client", exit: 4, match: "--status must be a numeric", meaning: "--status not a numeric keikkaTilaId", remedy: "pass a number, e.g. --status 9" },
      apiErr(404, "Keikka not found OR outside your visible scope", "verify keikkaId — but note this is NOT proof the row is absent: results mirror your permissions, so an existing keikka in another tenant 404s identically"),
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    notes: [
      "--status takes the numeric keikkaTilaId, NOT a name — e.g. `--status 9` (Toimitettu), `--status 8` (Peruttu), `--status 2` (Lähetetty). See the legend on `ib keikka list --help` or the `tila` GLOSSARY entry on `ib --help`.",
    ],
    examples: [
      "ib keikka update 9001 --status 9",
      "ib keikka update 9001 --status 8 --reason 'phone cancellation'",
    ],
  },
  {
    command: "ib keikka drivers assign",
    description:
      "Assign the default driver to a keikka. POST /api/keikka/defaultDriver/assign/:keikkaId; driver is selected by the backend from JWT/keikka context.",
    permissions: ["auth.page.grid.tilaus.edit"],
    args: [{ name: "keikkaId", type: "number", description: "keikkaId to assign default driver to" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, driver:{personId,name} } (raw backend response)",
    errors: [
      apiErr(404, "Keikka not found OR outside your visible scope", "verify keikkaId — but note this is NOT proof the row is absent: results mirror your permissions, so an existing keikka in another tenant 404s identically"),
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    examples: [
      "ib keikka drivers assign 9001",
      "ib keikka drivers assign 9001 --dry-run",
    ],
  },

  {
    command: "ib keikka search",
    description:
      "Search keikkas via the backend full-text search: phone number, keikkaId, worksite name/number, invoice reference. Returns deduped hits (one per keikka), newest first.",
    auth: "any",
    args: [{ name: "query", type: "string", required: false, description: "Full-text search string (phone, keikkaId, worksite name/number, invoice ref) — or pass --search" }],
    flags: [
      { name: "search", type: "string", description: "Search query (alias for the <query> positional)" },
      { name: "limit", type: "number", description: "Max hits (client-side; backend caps at 100)" },
    ],
    outputShape:
      "ListEnvelope<{ keikkaId, title, pumppuAika, customerName, worksiteName, address, contactPerson, contactPhone }>",
    errors: COMMON_AUTH_ERRORS,
    notes: [
      "Backed by the deployed GET /api/keikka/search (same path the AI order tool uses) — no deploy gate.",
      "Scope: the active company (ownerAsiakasId from the session token).",
    ],
    examples: [
      "ib keikka search 0401234567",
      "ib keikka search \"As Oy Esimerkki\" --limit 3",
    ],
  },
  {
    command: "ib keikka log",
    description:
      "Change-tracker audit trail for one keikka — who changed which field, when, old→new, with --reason. Folds in the keikka's keikkaBetoni (concrete-line) rows. Alias of `ib log entity keikka`. GET /api/changes/keikka/:keikkaId/:ownerAsiakasId.",
    auth: "any",
    args: [{ name: "keikkaId", type: "number", description: "keikkaId" }],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by fieldName (e.g. kuskit, laskuMemo, keikkaTilaId)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName, keikkaTilaContext, deviceType }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit to reach older rows (`--field` only narrows the page you already fetched)"),
      apiErr(403, "Not a member of that company (and not admin)", "ib company switch to that owner, or use an admin token")
    ),
    seeAlso: ["ib log entity", "ib log by-entity-date"],
    examples: ["ib keikka log 12345", "ib keikka log 12345 --field kuskit"],
  },
  {
    command: "ib keikka validate",
    description:
      "Validate a keikka (or a whole day with --date) against the reminders-drawer rules",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "keikkaId", type: "number", required: false, description: "keikkaId to validate (omit when using --date)" }],
    flags: [
      { name: "date", type: "date", description: "Validate every keikka for this date (YYYY-MM-DD or today/yesterday/tomorrow)" },
    ],
    outputShape:
      "single: { keikkaId, isValid, validationEnabled, summary:{totalIssues,critical,high,medium,low,notification,categories}, issues:[{type,message,priority,priorityName,category,categoryName,field}] } | day: { items:[{ keikkaId, isValid, summary, issues }], count, dayTotals:{totalIssues,critical,invalidKeikkas}, validationEnabled }",
    errors: [
      apiErr(404, "Keikka not found OR outside your visible scope", "verify keikkaId — but note this is NOT proof the row is absent: results mirror your permissions, so an existing keikka in another tenant 404s identically"),
      apiErr(400, "Bad date / keikkaId", "use YYYY-MM-DD or a positive integer"),
      ...permErrors("auth.page.grid.tilaus.read"),
    ],
    notes: [
      "validationEnabled is the per-company grid master toggle; rules run regardless. Single 404 if the keikka is not visible; day mode validates every keikka for the date.",
    ],
    seeAlso: ["ib validate", "ib keikka get"],
    examples: ["ib keikka validate 9001", "ib keikka validate --date today"],
  },

  // ─── stats (1) ───────────────────────────────────────────────────────────
  {
    command: "ib stats",
    description:
      "Aggregated delivery statistics for a date range: m³ volume, order counts, and breakdowns by customer/vehicle/driver/worksite/status/day. Read-only; scoped to what the caller can see in the grid.",
    flags: [
      { name: "from", type: "date", description: "Start date (YYYY-MM-DD or today/yesterday/tomorrow)" },
      { name: "to", type: "date", description: "End date (YYYY-MM-DD or today/yesterday/tomorrow)" },
      { name: "today", type: "boolean", description: "Shortcut for --from today --to today" },
      { name: "month", type: "string", description: "Whole calendar month YYYY-MM (expands to first→last day)" },
      { name: "week", type: "date", description: "7-day window starting <start>" },
      { name: "by", type: "string", description: "Single breakdown: customer|vehicle|driver|worksite|status|day (omit for full bundle)", allowed: ["customer", "vehicle", "driver", "worksite", "status", "day"] },
      { name: "all", type: "boolean", description: "All tenants (requires developer/system-admin access; 403 otherwise)" },
    ],
    outputShape:
      "No --by: { period, totals:{orders,m3,activeVehicles,activeDrivers}, byStatus, byCustomer, byVehicle, byDriver, byWorksite, byDay }. With --by: ListEnvelope of that one breakdown.",
    errors: COMMON_AUTH_ERRORS,
    notes: [
      "Default range is today. Exactly one of --today/--month/--week/(--from & --to).",
      "Deploy-gated: returns 404 until GET /api/cli/stats is deployed.",
      "Revenue and driver hours are out of scope (v1).",
      "--all requires developer/system-admin access (403 for everyone else); omit to stay scoped to your own visibility.",
    ],
    examples: [
      "ib stats --month 2026-06",
      "ib stats --from 2026-06-01 --to 2026-06-07 --by driver",
      "ib stats --today --pretty",
      "ib stats --today --all",
    ],
  },
];
