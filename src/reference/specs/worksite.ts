// worksite specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearHint, clearNote, apiErr, limitErr, authErrors, COMMON_AUTH_ERRORS, permErrors, TRUNCATED_NOTE, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE, LIMIT_500_FLAG, OWNER_ASIAKAS_FLAG, SEARCH_ALIAS_FLAG, MERGE_DRY_RUN_FIRST_NOTE, MERGE_VALIDATE_READONLY_NOTE } from "./shared.js";

export const WORKSITE_SPECS: CommandSpec[] = [

  // ─── worksite (6) ────────────────────────────────────────────────────────
  {
    command: "ib worksite list",
    description:
      "List worksites (tyomaat) visible to the active company. ownerAsiakasId derived from JWT.",
    permissions: ["auth.page.tyomaa.read"],
    flags: [
      {
        name: "customer",
        type: "number",
        description: "Filter by parent asiakasId",
      },
      LIMIT_500_FLAG,
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ tyomaaId, name, address, asiakasId, city }>" + TRUNCATED_NOTE,
    errors: [limitErr("pass a positive integer; this command caps at 500 — page past it with `--cursor` from the previous response's `nextCursor`"), ...permErrors("auth.page.tyomaa.read")],
    examples: ["ib worksite list", "ib worksite list --customer 1349"],
  },
  {
    command: "ib worksite get",
    aliases: ["ib worksite show"],
    description:
      "Get a single worksite (tyomaa) by id with every user-relevant field in camelCase: name, tyomaaNum, the full address (address/address2/postalCode/city + formattedAddress), coords, drivingInstructions (ajo-ohje), comment (memo), invoiceRef (laskuViite), contactPersonId, geofenceRadius, the live customer (asiakasId/asiakasNimi, derived from the most recent keikka), ownerAsiakasId and created/modified timestamps. Two heavy JSON blobs are opt-in via flags; without them the record still reports cameraCount and hasBuildingData so you know whether to ask for the detail.",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId to fetch" }],
    flags: [
      {
        name: "include-building",
        type: "boolean",
        description:
          "Attach parsed Helsinki building registry data as rakennusData (heavy; default off)",
      },
      {
        name: "include-cameras",
        type: "boolean",
        description:
          "Attach nearby traffic cameras as cameras[] (heavy; default off)",
      },
    ],
    outputShape:
      "{ tyomaaId, name, tyomaaNum, address, address2, postalCode, city, formattedAddress, coords:{lat,lng}|null, drivingInstructions, comment, invoiceRef, contactPersonId, geofenceRadius, asiakasId, asiakasNimi, ownerAsiakasId, createdTime, modifiedTime, cameraCount, hasBuildingData } (+ rakennusData with --include-building, + cameras[] with --include-cameras)",
    errors: [
      apiErr(404, "Worksite not found", "verify tyomaaId"),
      ...permErrors("auth.page.tyomaa.read"),
    ],
    examples: [
      "ib worksite get 99",
      "ib worksite get 99 --include-building --include-cameras",
    ],
  },
  {
    command: "ib worksite metrics",
    description:
      "Volume / keikka-count metrics for a worksite (GET /api/cli/worksite/metrics/:tyomaaId).",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [],
    outputShape: "{ tyomaaId, summary:{...}, monthlyBreakdown:[...] }",
    errors: [
      apiErr(404, "Worksite not found", "verify tyomaaId"),
      ...permErrors("auth.page.tyomaa.read"),
    ],
    examples: ["ib worksite metrics 99"],
  },
  {
    command: "ib worksite dates list",
    description: "List a worksite's compliance/permit dates (read-only).",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ tyomaaDateId, typeId, typeName, date, expirationDate, daysUntil, status, quantity }>",
    errors: [
      apiErr(400, "Bad tyomaaId", "use a positive integer"),
      ...permErrors("auth.page.tyomaa.read"),
    ],
    examples: ["ib worksite dates list 99"],
  },
  {
    command: "ib worksite dates expiring",
    description: "Company-wide worksite dates expiring within --days (default 30).",
    permissions: ["auth.page.tyomaa.read"],
    flags: [{ name: "days", type: "number", default: "30", description: "Look-ahead window (days)" }],
    outputShape:
      "ListEnvelope<{ tyomaaDateId, tyomaaId, tyomaaName, typeName, expirationDate, daysUntil, urgency }>",
    errors: [...permErrors("auth.page.tyomaa.read")],
    examples: ["ib worksite dates expiring --days 14"],
  },
  {
    command: "ib worksite create",
    description:
      "Create a new worksite via POST /api/tyomaa/new. Body forwarded verbatim.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON object with the new tyomaa fields",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ tyomaaId, ... } (raw backend response)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: [
      "ib worksite create --body '{\"name\":\"Site A\",\"address\":\"Main St 1\",\"asiakasId\":1349}'",
    ],
  },
  {
    command: "ib worksite update",
    description:
      "Update a worksite via POST /api/tyomaa/set (ownerAsiakasId derived from the session JWT; yyyymmdd defaults to today). Set fields with typed flags (--name/--num/--address/--address2/--postal-code/--city/--driving-instructions/--comment/--invoice-ref/--contact-person) and/or a --body/--from-json JSON patch with backend column names (typed flags win); at least one field is required. Omitted fields are PRESERVED (the backend read-merges the stored row); pass an empty string to CLEAR a field (e.g. --comment \"\"). " + clearNote("--comment"),
    permissions: ["auth.page.tyomaa.edit"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId to update" }],
    flags: [
      { name: "name", type: "string", description: "Worksite name (tyomaaNimi)" },
      { name: "num", type: "string", description: "Worksite number (tyomaaNum)" },
      { name: "address", type: "string", description: "Street address (tyomaaOsoite1)" },
      { name: "address2", type: "string", description: "Address line 2 (tyomaaOsoite2)" },
      { name: "postal-code", type: "string", description: "Postal code (tyomaaOsoite3)" },
      { name: "city", type: "string", description: "City (tyomaaOsoite4)" },
      { name: "driving-instructions", type: "string", description: "Driving instructions (tyomaaAjoOhje)" },
      { name: "comment", type: "string", description: "Free-text memo (tyomaaMemo; " + clearHint("--comment") + ")" },
      { name: "invoice-ref", type: "string", description: "Invoice reference (laskuViite)" },
      { name: "contact-person", type: "number", description: "Contact personId (tyomaaContactPersonId; 0 = none)" },
      {
        name: "body",
        type: "json",
        description: "Patch body (JSON, backend column names e.g. tyomaaMemo — NOT the camelCase read keys), merged UNDER the typed flags. Mutually exclusive with --from-json.",
      },
      {
        name: "from-json",
        type: "string",
        description: "Read the patch body from a file (or - for stdin); shell-safe alternative to --body. Mutually exclusive with --body.",
      },
      {
        name: "yyyymmdd",
        type: "date",
        default: "today",
        description: "Effective date segment YYYYMMDD (defaults to today)",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, ... } (raw backend response); --dry-run returns { dryRun: true, wouldUpdate: { <provided fields>, omittedFieldsPreserved: true } }",
    errors: [
      // CLIENT-side, not a backend 400 (fb#668): the empty-patch guard is a
      // `failWith(..., 4)` in the action, so nothing ever arrives over HTTP with
      // this meaning. Documented as `http: 400` it was doubly broken — dead by
      // the fb#280 rule (a client failure can only be matched via `origin`), AND
      // it shadowed the real "Validation failed" 400 below it.
      { origin: "client", exit: 4, match: "requires at least one field", meaning: "No fields to update", remedy: "pass at least one typed flag or a --body/--from-json patch" },
      apiErr(400, "Validation failed", "fix the patch fields"),
      apiErr(404, "Worksite not found", "verify tyomaaId"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    notes: [
      "Prefer typed flags for the common fields — --comment maps to tyomaaMemo, --address to tyomaaOsoite1. Use --body/--from-json only for columns without a typed flag (e.g. rakennusDataJSON, asiakasId).",
      "Address changes re-geocode the worksite server-side (lat/lng refresh).",
      "Partial-update safety is server-side (tyomaa.setData read-merge, fb#234) — against an older backend without it, a partial body NULLs omitted columns. Verify with --dry-run first.",
    ],
    examples: [
      'ib worksite update 99 --comment "Pickup at gate B" --reason "gate info"',
      'ib worksite update 99 --address "Uusikatu 2" --postal-code 00100 --city Helsinki --reason "address fix"',
      'ib worksite update 99 --comment "" --reason "clear memo"',
      "ib worksite update 99 --body '{\"tyomaaMemo\":\"Pickup at gate B\"}' --reason \"gate info\"",
    ],
  },
  {
    command: "ib worksite search",
    description:
      "Free-text worksite search (POST /api/tyomaa/search). The query full-text-matches the worksite name, ALL FOUR address lines (street / line 2 / postal code / city), driving instructions, memo, formatted address, worksite number AND the contact person's name / phone / email — so a street fragment like 'Mannerheimintie' finds the worksite. Scoped to the active company. Safe under --read-only (sent as a read request — a tenant-scoped read over POST, distinct from a meta/diagnostic call — so it does NOT trip the read-only lock or the acting-as write line).",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "query", type: "string", required: false, description: "search string (or pass --search)" }],
    flags: [
      SEARCH_ALIAS_FLAG,
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results (backend caps at 100)",
      },
      {
        name: "my-companies",
        type: "boolean",
        description: "Search across every company you belong to (customer/worksite/person)",
      },
    ],
    outputShape:
      "ListEnvelope<{ tyomaaId, name, tyomaaNum, address, address2, postalCode, city, formattedAddress, coords:{lat,lng}|null, drivingInstructions, comment }>",
    errors: [limitErr("pass a positive integer; the backend caps at 100, so narrow the search term rather than raising the cap"), ...permErrors("auth.page.tyomaa.read")],
    examples: [
      "ib worksite search Mannerheimintie",
      "ib worksite search 'Jokiniementie 13' --limit 10",
    ],
  },
  {
    command: "ib worksite dashboard",
    description:
      "One-shot Address Information Dashboard report for a worksite (tyomaa) — merges weather, building, cadastral parcel, nearby traffic cameras, nearby sijainnit, worksite deliveries, and nearby vehicles into a single JSON, with each section independently degrading to forbidden/error instead of failing the whole report. Resolve the point from EXACTLY ONE of the positional tyomaaId or --address.",
    auth: "any",
    args: [
      {
        name: "tyomaaId",
        type: "number",
        required: false,
        description: "tyomaaId to report on (mutually exclusive with --address)",
      },
    ],
    flags: [
      {
        name: "address",
        type: "string",
        description: "Street address to resolve the point from, instead of tyomaaId (mutually exclusive)",
      },
    ],
    outputShape:
      "{ point:{lat,lng}|null, address:string|null, weather, building, parcel, cameras, sijainti, deliveries, vehicles } — each section is { status:'ok'|'empty'|'forbidden'|'error', data?, error? }; a forbidden/error section never fails the whole command",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing or ambiguous point input", remedy: "pass exactly one of <tyomaaId> or --address" },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Per-section gating mirrors the FE dashboard: weather/cameras/vehicles degrade to forbidden when the company module is off; building/parcel are open to any authenticated user; a bad address or unresolvable point degrades EVERY section to error instead of failing the command.",
      "`deliveries` reports worksite delivery volume — tyomaaId-scoped when invoked by <tyomaaId>, or the nearest owned worksite at the geocoded point when invoked via --address; `vehicles` reports nearby BetoniJerry ecofleet vehicles; `sijainti` reports sijainnit found NEARBY the resolved point (~2 km).",
    ],
    seeAlso: ["ib sijainti dashboard", "ib opendata building", "ib opendata parcel", "ib worksite get"],
    examples: [
      "ib worksite dashboard 1234",
      'ib worksite dashboard --address "Oraspolku 2, Helsinki"',
    ],
  },
  {
    command: "ib worksite log",
    description:
      "Change-tracker audit trail for one worksite (tyomaa) — who changed which field, when, old→new, with --reason. Alias of `ib log entity tyomaa`. GET /api/changes/tyomaa/:tyomaaId/:ownerAsiakasId.",
    auth: "any",
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [
      OWNER_ASIAKAS_FLAG,
      LIMIT_500_FLAG,
      { name: "field", type: "string", description: "Filter by fieldName" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit to reach older rows (`--field` only narrows the page you already fetched)"),
      apiErr(403, "Not a member of that company (and not admin)", "ib company switch to that owner, or use an admin token")
    ),
    seeAlso: ["ib log entity"],
    examples: ["ib worksite log 7"],
  },

  {
    command: "ib worksite duplicates",
    description:
      "List likely-duplicate worksite (tyomaa) pairs for one tenant: strict name+address+number matches, plus the anonymous same-address cluster (nameless rows sharing an address + compatible number/memo/reference/contact). Read-only; admin gated server-side. Owner defaults to your active company; --owner scans another tenant. Feeds `ib worksite merge`.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId to scan (default: active company)" },
    ],
    outputShape:
      "{ items: [{ id1, name1, id2, name2, matchCode: 'tyomaa_strict'|'tyomaa_anonymous', matchValue, confidence: 'high'|'medium' }], count, truncated? } — truncated=true when capped at 100 pairs",
    errors: [
      apiErr(400, "ownerAsiakasId missing/invalid", "pass --owner <id>, or set an active company"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "tyomaa_anonymous is a medium-confidence heuristic (both rows nameless, same normalized address, matching number/memo/laskuViite/contact, both older than 1 month) — a human confirms before merging.",
      "Each pair is returned once (id1 < id2), top 100 by confidence.",
    ],
    seeAlso: ["ib worksite merge", "ib worksite get"],
    examples: ["ib worksite duplicates", "ib worksite duplicates --owner 1349"],
  },

  {
    command: "ib worksite merge",
    description:
      "Merge two duplicate worksites: the secondary's references (keikka / person / grid) move onto the main, then the secondary is DELETED. IRREVERSIBLE and admin gated. --dry-run runs the read-only /validate safety check (what would move + conflicts) and NEVER merges. A real merge requires --reason.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "main", type: "number", description: "tyomaaId to KEEP — references merge into this one (required)" },
      { name: "secondary", type: "number", description: "tyomaaId to REMOVE — merged away then deleted (required)" },
      OWNER_ASIAKAS_FLAG,
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    reasonDetail: "(worksite merge is irreversible; --dry-run previews via /validate)",
    dryRunKind: "client",
    outputShape:
      "real: { success, safetyValidation, timestamp, ... } | dry-run: { dryRun: true, validation: { success, ... } }",
    errors: [
      apiErr(400, "Validation failed (missing/equal ids, or safety check)", "check --main/--secondary; run --dry-run first"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      apiErr(404, "One or both worksites not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      MERGE_DRY_RUN_FIRST_NOTE,
      MERGE_VALIDATE_READONLY_NOTE,
      "Affects keikka / person / grid rows and the change history; caches are invalidated server-side.",
    ],
    seeAlso: ["ib worksite duplicates", "ib worksite delete"],
    examples: [
      "ib worksite merge --main 701 --secondary 702 --dry-run",
      "ib worksite merge --main 701 --secondary 702 --reason 'dedupe: same address'",
    ],
  },
];
