// vehicle specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, limitErr, authErrors, permErrors, TRUNCATED_NOTE, LOG_CAPPED_NOTE, LOG_FIELD_HINT_NOTE, VEHICLE_ASIAKAS_PERMISSION, VEHICLE_ASIAKAS_403, VEHICLE_PLACEHOLDER_NOTE, VEHICLE_ORDERING_NOTE, VEHICLE_OWNER_NOTE, VEHICLE_LIST_PRETTY_COLUMNS, DRIVER_DATE_ARG, DRIVER_DATE_FLAG, DRIVER_DATE_NOTE, LIMIT_500_FLAG, OWNER_ASIAKAS_FLAG, SEARCH_ALIAS_FLAG } from "./shared.js";

export const VEHICLE_SPECS: CommandSpec[] = [

  // ─── vehicle (16) ─────────────────────────────────────────────────────────
  {
    command: "ib vehicle list",
    description:
      "List vehicles visible to the active company. ownerAsiakasId derived from JWT. Rows are self-describing (showInGrid/firstDate/lastDate/deletedTime). Default scope = non-deleted with no narrowing, so grid-hidden AND expired vehicles ARE included; only soft-deleted are excluded. Use the flags to narrow or to reveal deleted rows. --asiakas lists ANOTHER company's fleet (cross-tenant; developer/admin lever) instead of the active company.",
    permissions: ["auth.page.vehicle.read", VEHICLE_ASIAKAS_PERMISSION],
    seeAlso: ["ib vehicle types"],
    flags: [
      LIMIT_500_FLAG,
      {
        name: "deleted",
        type: "boolean",
        description: "Include soft-deleted vehicles (default: excluded)",
      },
      {
        name: "grid-only",
        type: "boolean",
        description: "Only vehicles shown in the grid (showInGrid=1)",
      },
      {
        name: "valid-on",
        type: "date",
        description:
          "Only vehicles whose validity window covers this day (YYYY-MM-DD or today/yesterday/tomorrow)",
      },
      {
        name: "type",
        type: "number",
        description: "Only this vehicleTypeId (see `ib vehicle types`)",
      },
      {
        name: "asiakas",
        type: "number",
        description:
          "List another company's fleet (cross-tenant). Requires sysadmin/developer or a vehicle-manage role on that tenant; default = active company.",
      },
      {
        name: "cursor",
        type: "string",
        description: "Pagination cursor (from a previous page's nextCursor)",
      },
    ],
    outputShape:
      "ListEnvelope<{ vehicleId, vehicleNo, plate, name, type, typeName, capacity, sortNo, showInGrid:boolean, firstDate:YYYY-MM-DD|null, lastDate:YYYY-MM-DD|null, deletedTime:ISO|null, asiakasId, ownerAsiakasId, placeholder?:true }>" + TRUNCATED_NOTE,
    prettyColumns: VEHICLE_LIST_PRETTY_COLUMNS,
    errors: [
      limitErr("pass a positive integer; this command caps at 500 — page past it with `--cursor` from the previous response's `nextCursor`"),
      VEHICLE_ASIAKAS_403,
      ...permErrors("auth.page.vehicle.read"),
    ],
    notes: [VEHICLE_PLACEHOLDER_NOTE, VEHICLE_ORDERING_NOTE, VEHICLE_OWNER_NOTE],
    examples: [
      "ib vehicle list",
      "ib vehicle list --pretty",
      "ib vehicle list --grid-only --valid-on today",
      "ib vehicle list --deleted",
      "ib vehicle list --type 1",
      "ib vehicle list --asiakas 1380",
    ],
  },
  {
    command: "ib vehicle get",
    aliases: ["ib vehicle show"],
    description:
      "Get a single vehicle by id. --asiakas reads a vehicle owned by ANOTHER company (cross-tenant; developer/admin lever) — without it the lookup is scoped to the active company and a foreign vehicleId returns 404.",
    permissions: ["auth.page.vehicle.read", VEHICLE_ASIAKAS_PERMISSION],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId to fetch" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description:
          "Read a vehicle owned by this company (cross-tenant). Requires sysadmin/developer or a vehicle-manage role on that tenant; default = active company.",
      },
    ],
    outputShape:
      "{ vehicleId, vehicleNo, name, plate, type, typeName, boomLength, capacity, sortNo, firstDate:YYYY-MM-DD|null, lastDate:YYYY-MM-DD|null, memo, billingProductId, asiakasId, ownerAsiakasId, defaultDriverId, showInGrid:boolean, showInReports:boolean, useNoDriverBar:boolean, isRestricted:boolean, hasGpsTracking:boolean }",
    errors: [
      apiErr(404, "Vehicle not found", "verify vehicleId (and --asiakas if it belongs to another company)"),
      VEHICLE_ASIAKAS_403,
      ...permErrors("auth.page.vehicle.read"),
    ],
    notes: [VEHICLE_OWNER_NOTE],
    examples: ["ib vehicle get 7", "ib vehicle get 159 --asiakas 1380"],
  },
  {
    command: "ib vehicle status",
    description:
      "Current operational status for a vehicle: current driver, current keikka, and the latest GPS ping (via the shared Ecofleet cache, best-effort). gpsAvailable:false when Ecofleet is not enabled.",
    permissions: ["auth.page.vehicle.read"],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId to inspect" }],
    flags: [],
    outputShape:
      "{ vehicleId, plate, currentDriver:{personId,name}|null, currentKeikka:{keikkaId,tila}|null, lastGpsPing:{lat,lng,speed,direction,engineState,address,at,ageMinutes,stale}|null, gpsAvailable, staleAfterMinutes }",
    errors: [
      apiErr(404, "Vehicle not found", "verify vehicleId"),
      ...permErrors("auth.page.vehicle.read"),
    ],
    notes: [
      "`lastGpsPing` is the LATEST ping, which says nothing about how old it is — a dead tracker's last ping keeps its speed and direction, so it reads as a truck still driving. Check `stale` (ageMinutes > staleAfterMinutes, default 60) before treating the coordinates as the vehicle's current position. Same contract as `ib vehicle locations`.",
      "lastGpsPing is null when Ecofleet is disabled, the lookup failed (best-effort — a GPS outage never fails the command), or the fleet entry had no coordinate fix. Null is not evidence the vehicle is untracked; check `gpsAvailable`.",
    ],
    seeAlso: ["ib vehicle locations"],
    examples: ["ib vehicle status 7", "ib vehicle status 7 --pretty"],
  },
  {
    command: "ib vehicle types",
    description:
      "List vehicle types (vehicleTypeId + name) for the active company. --asiakas lists ANOTHER company's types (cross-tenant) — needed for `ib vehicle create --asiakas` since types are tenant-defined.",
    permissions: ["auth.page.vehicle.read", VEHICLE_ASIAKAS_PERMISSION],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description:
          "List another company's vehicle types (cross-tenant). Requires sysadmin/developer or a vehicle-manage role on that tenant; default = active company.",
      },
    ],
    outputShape: "ListEnvelope<{ vehicleTypeId, name }>",
    errors: [VEHICLE_ASIAKAS_403, ...permErrors("auth.page.vehicle.read")],
    examples: ["ib vehicle types", "ib vehicle types --pretty", "ib vehicle types --asiakas 1380"],
  },
  {
    command: "ib vehicle search",
    description:
      "Search vehicles by reg-no / name / fleet-number substring (LIKE on vehicleRegNo / vehicleNimi / vehicleNo). --asiakas searches ANOTHER company's fleet (cross-tenant; same gate as `ib vehicle list --asiakas`).",
    permissions: ["auth.page.vehicle.read", VEHICLE_ASIAKAS_PERMISSION],
    args: [{ name: "query", type: "string", required: false, description: "substring to match (reg-no, name, or fleet number) — or pass --search" }],
    flags: [
      SEARCH_ALIAS_FLAG,
      LIMIT_500_FLAG,
      {
        name: "asiakas",
        type: "number",
        description:
          "Search another company's fleet (cross-tenant). Requires sysadmin/developer or a vehicle-manage role on that tenant; default = active company.",
      },
    ],
    outputShape:
      "ListEnvelope<{ vehicleId, vehicleNo, plate, name, type, typeName, capacity, sortNo, showInGrid:boolean, firstDate:YYYY-MM-DD|null, lastDate:YYYY-MM-DD|null, deletedTime:ISO|null, asiakasId, ownerAsiakasId, placeholder?:true }>" + TRUNCATED_NOTE,
    prettyColumns: VEHICLE_LIST_PRETTY_COLUMNS,
    errors: [
      limitErr("pass a positive integer; this command caps at 500, so narrow the search term rather than raising the cap"),
      VEHICLE_ASIAKAS_403,
      ...permErrors("auth.page.vehicle.read"),
    ],
    notes: [VEHICLE_PLACEHOLDER_NOTE, VEHICLE_ORDERING_NOTE, VEHICLE_OWNER_NOTE],
    examples: ["ib vehicle search ABC", "ib vehicle search kuorma --limit 20", "ib vehicle search 82", "ib vehicle search ABC --asiakas 1380"],
  },
  {
    command: "ib vehicle create",
    description:
      "Create a vehicle. Two-step backend flow (POST /api/vehicle/new/:asiakasId then /save). --asiakas creates the vehicle UNDER that tenant (it rides the /new path param, which stamps ownerAsiakasId+asiakasId on the stub — fb#94); default = active company from JWT. Requires an admin/owner/vehicleHandler role on the target tenant. Dry-run previews via /new without inserting.",
    permissions: ["auth.page.vehicle.edit"],
    flags: [
      { name: "reg", type: "string", description: "Registration number (vehicleRegNo)" },
      { name: "name", type: "string", description: "Display name (vehicleNimi)" },
      { name: "no", type: "number", description: "Fleet number (vehicleNo)" },
      { name: "type", type: "number", description: "vehicleTypeId (see ib vehicle types)" },
      { name: "memo", type: "string", description: "Free-text memo" },
      { name: "default-driver", type: "number", description: "Default driver personId" },
      { name: "capacity", type: "number", description: "Concrete capacity in m3 (vehicleM3)" },
      { name: "puomi", type: "number", description: "Boom length in metres (vehiclePuomi — informational; BetoniJerry matching uses sijainti puomiMin/puomiMax since 2026-07)" },
      { name: "asiakas", type: "number", description: "Target asiakasId to create the vehicle under (defaults to active company; needs a vehicle-manage role on that tenant)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ vehicleId, ... } (raw backend save response) | { dryRun, wouldCreate }",
    errors: [
      apiErr(400, "Validation failed", "fix the field flags"),
      // Matched on the backend's Finnish denyMessage (vehicleRoutes.js
      // `vehicleEdit` → requireCompanyRole denyMessage).
      //
      // The target is `--asiakas ?? your own company`, so this fires for a
      // caller lacking the edit role on their OWN company too — the meaning must
      // not blame `--asiakas`, which was the pre-review wording and would send
      // someone hunting a flag they never passed.
      apiErr(
        403,
        "No vehicle-edit access on the target tenant (--asiakas if given, otherwise your active company)",
        "you need an admin/owner/vehicleHandler role on that tenant",
        "ei oikeuksia tämän asiakkaan ajoneuvoihin"
      ),
      ...permErrors("auth.page.vehicle.edit"),
    ],
    examples: [
      "ib vehicle create --reg ABC-123 --type 1 --capacity 7.5 --reason 'new truck'",
      "ib vehicle create --reg ABC-123 --type 2 --puomi 24 --asiakas 1380 --reason 'jerry onboarding'",
      "ib vehicle create --reg ABC-123 --dry-run",
    ],
  },
  {
    command: "ib vehicle update",
    description:
      "Update a vehicle (read-merge-write: only provided flags change; others preserved). POST /api/vehicle/save.",
    permissions: ["auth.page.vehicle.edit"],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId to update" }],
    flags: [
      { name: "reg", type: "string", description: "Registration number" },
      { name: "name", type: "string", description: "Display name" },
      { name: "no", type: "number", description: "Fleet number" },
      { name: "type", type: "number", description: "vehicleTypeId" },
      { name: "memo", type: "string", description: "Free-text memo" },
      { name: "capacity", type: "number", description: "Concrete capacity in m3" },
      { name: "puomi", type: "number", description: "Boom length in metres (vehiclePuomi — informational; BetoniJerry matching uses sijainti puomiMin/puomiMax since 2026-07)" },
      { name: "asiakas", type: "number", description: "Owning asiakasId" },
      { name: "show-in-grid", type: "boolean", description: "Whether the vehicle appears in the grid (true/false)" },
      { name: "first-date", type: "date", description: "Start of validity window (firstDate); YYYY-MM-DD or today/yesterday/tomorrow" },
      { name: "last-date", type: "date", description: "End of validity window (lastDate); YYYY-MM-DD or today/yesterday/tomorrow" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "On write: the saved vehicle record. With --dry-run: { dryRun: true, vehicleId, wouldChange: { field: { from, to } } } — the field-level diff, computed client-side without POSTing (the save route ignores X-Dry-Run, so the preview cannot persist).",
    errors: [
      apiErr(404, "Vehicle not found", "verify vehicleId"),
      ...permErrors("auth.page.vehicle.edit"),
    ],
    examples: [
      "ib vehicle update 70 --capacity 8 --reason 'remeasured'",
      "ib vehicle update 70 --show-in-grid false --dry-run",
      "ib vehicle update 70 --last-date 2026-12-31 --reason 'retiring'",
    ],
  },
  {
    command: "ib vehicle dates list",
    description: "List a vehicle's inspection/certification/insurance dates.",
    permissions: ["auth.page.vehicle.read"],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ vehicleDateId, typeId, typeName, dateValue, expirationDate, dismissedUntil, quantity, status, daysUntil }>",
    errors: permErrors("auth.page.vehicle.read"),
    examples: ["ib vehicle dates list 7"],
  },
  {
    command: "ib vehicle dates expiring",
    description: "List expiring vehicle dates across the fleet within a days-ahead window.",
    permissions: ["auth.page.vehicle.read"],
    flags: [{ name: "days", type: "number", default: "30", description: "Days-ahead window" }],
    outputShape:
      "ListEnvelope<{ vehicleDateId, vehicleId, typeName, dateValue, expirationDate, daysUntil, urgency }>",
    errors: permErrors("auth.page.vehicle.read"),
    examples: ["ib vehicle dates expiring", "ib vehicle dates expiring --days 60 --pretty"],
  },
  {
    command: "ib vehicle locations",
    description:
      "Fleet-wide live GPS snapshot for the active company (via Ecofleet, cached 60s). gpsAvailable:false when Ecofleet is not enabled.",
    permissions: ["auth.page.vehicle.read"],
    flags: [],
    outputShape:
      "ListEnvelope<{ vehicleId|null, matched, plate, objectName, lat, lng, speed, direction, engineState, address, at, ageMinutes|null, stale }> & { gpsAvailable, staleAfterMinutes }",
    errors: permErrors("auth.page.vehicle.read"),
    notes: [
      "Rows are Ecofleet OBJECTS, not vehicles: an object whose plate matches no dbo.vehicle row of the active company (retired truck, subcontractor unit, typo'd reg-no) returns vehicleId:null with matched:false. That is expected data, not an error — filter on `matched`, don't treat the null as a failure.",
      "`stale:true` means the TRACKER stopped reporting (ageMinutes > staleAfterMinutes, default 60), so the coordinates say where the vehicle was, not where it is. A months-old ping still carries its last speed/direction, so without this flag a dead tracker reads as a truck currently driving.",
      "`stale` is about the tracker, not the truck: a depot-parked vehicle whose tracker pinged 20 minutes ago is fresh (stale:false) with speed 0. Use `ageMinutes` to apply your own threshold — `staleAfterMinutes` echoes the one behind the boolean.",
      "A missing or unparseable ping timestamp yields ageMinutes:null and stale:true — freshness cannot be vouched for, so it is never reported fresh.",
    ],
    examples: ["ib vehicle locations", "ib vehicle locations --pretty"],
  },
  {
    command: "ib vehicle timeline",
    description:
      "Per-day GPS timeline for a vehicle (snapshot-based, no external API): named stop segments (sijainti/tyomaa) and travel legs with durations.",
    permissions: ["auth.page.vehicle.read"],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId to inspect" }],
    flags: [
      { name: "date", type: "date", default: "today", description: "Day (YYYY-MM-DD or today/yesterday/tomorrow); Europe/Helsinki" },
    ],
    outputShape:
      "ListEnvelope<{ type, locationType?, locationId?, locationName?, locationAddress?, sijaintiTypeName?, asiakasNimi?, arrived, departed, durationMin, distanceKm? }> & { gpsAvailable }",
    errors: [
      apiErr(404, "Vehicle not found", "verify vehicleId"),
      ...permErrors("auth.page.vehicle.read"),
    ],
    examples: ["ib vehicle timeline 7", "ib vehicle timeline 7 --date yesterday"],
  },
  {
    command: "ib vehicle route",
    description:
      "Per-day ordered GPS track points (polyline) for a vehicle (snapshot-based, no external API).",
    permissions: ["auth.page.vehicle.read"],
    args: [{ name: "vehicleId", type: "number", description: "vehicleId to inspect" }],
    flags: [
      { name: "date", type: "date", default: "today", description: "Day (YYYY-MM-DD or today/yesterday/tomorrow); Europe/Helsinki" },
    ],
    outputShape: "ListEnvelope<{ lat, lng }> & { gpsAvailable }",
    errors: [
      apiErr(404, "Vehicle not found", "verify vehicleId"),
      ...permErrors("auth.page.vehicle.read"),
    ],
    examples: ["ib vehicle route 7", "ib vehicle route 7 --date 2026-05-31"],
  },
  {
    command: "ib vehicle visits",
    description:
      "The active company's own vehicles that visited a worksite (tyomaa) or location (sijainti), grouped into visits with arrival/departure/duration (snapshot-based). Results are filtered to the caller's own fleet — other tenants' vehicles at a shared sijainti are not returned; a tyomaa must belong to the active company (else 404).",
    permissions: ["auth.page.vehicle.read"],
    args: [
      { name: "filterType", type: "string", description: "'tyomaa' or 'sijainti'" },
      { name: "id", type: "number", description: "tyomaaId or sijaintiId" },
    ],
    flags: [
      { name: "days", type: "number", description: "Look-back window in days (omit for all-time)" },
      { name: "date", type: "date", description: "Only visits on this day (YYYY-MM-DD or today/yesterday/tomorrow; Europe/Helsinki). Filtered client-side; auto-bounds the look-back when --days is omitted" },
    ],
    outputShape:
      "ListEnvelope<{ vehicleId, plate, objectName, arrived, departed, durationMin }> & { gpsAvailable }",
    errors: [
      { origin: "client", exit: 4, match: "filterType", meaning: "Invalid filterType", remedy: "use tyomaa or sijainti" },
      { origin: "client", exit: 4, match: "date must be", meaning: "Bad --date", remedy: "YYYY-MM-DD or today/yesterday/tomorrow" },
      apiErr(404, "tyomaa not found / not owned", "verify tyomaaId belongs to the active company"),
      ...permErrors("auth.page.vehicle.read"),
    ],
    notes: [
      "filterType and id are POSITIONAL (`visits sijainti 60`), not flags — there is no --sijainti/--tyomaa option.",
      "Resolving a sijaintiId by name: supplier plants belong to OTHER companies, so use `ib sijainti list --search <name> --all` (plain `sijainti list` hides them). Alternatively `ib vehicle timeline <vehicleId> --date <d>` labels each stop with its sijaintiId/tyomaaId.",
    ],
    seeAlso: ["ib sijainti list", "ib vehicle timeline"],
    examples: [
      "ib vehicle visits tyomaa 17 --days 30",
      "ib vehicle visits sijainti 3",
      "ib vehicle visits sijainti 60 --date 2026-04-15",
    ],
  },
  {
    command: "ib vehicle log",
    description:
      "Change-tracker audit trail for one vehicle — who changed which field, when, old→new, with --reason. Alias of `ib log entity vehicle`. For day-driver history use `ib vehicle driver history` (personPvm-based). GET /api/changes/vehicle/:vehicleId/:ownerAsiakasId.",
    auth: "any",
    args: [{ name: "vehicleId", type: "number", description: "vehicleId" }],
    flags: [
      OWNER_ASIAKAS_FLAG,
      LIMIT_500_FLAG,
      { name: "field", type: "string", description: "Filter by fieldName (e.g. vehicleRegNo)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      limitErr("pass a positive integer; this cursor-less route caps at 500 — raise --limit to reach older rows (`--field` only narrows the page you already fetched)"),
      apiErr(403, "Not a member of that company (and not admin)", "ib company switch to that owner, or use an admin token")
    ),
    seeAlso: ["ib log entity", "ib vehicle driver history"],
    examples: ["ib vehicle log 53"],
  },

  // ─── vehicle driver (day-driver dispatch + standing default driver) ────────
  // Day driver vs default driver: the DAY driver (personPvm.vehicleId for one
  // date) is who actually drives the vehicle that day; the DEFAULT driver
  // (vehicle.defaultKuski_personId) is the standing/template driver. The grid
  // reads day drivers from personPvm. Fleet "who's absent" lives at `ib person absences`.
  {
    command: "ib vehicle driver board",
    description:
      "All grid-eligible vehicles for a day with their day driver, gap status (Ei kuljettajaa), and keikka load. The dispatcher's day view.",
    permissions: ["auth.page.grid.read"],
    args: [DRIVER_DATE_ARG],
    flags: [DRIVER_DATE_FLAG],
    outputShape:
      "ListEnvelope<{ vehicleId, plate, name, type, typeName, driverPersonId, driverName, hasDriver, needsDriver, keikkaCount, m3, placeholder? }>",
    errors: permErrors("auth.page.grid.read"),
    notes: [
      "driverPersonId/driverName come from personPvm (the live day-driver source).",
      "needsDriver = the vehicle uses the no-driver bar AND has no day driver (i.e. it's a gap). Workload (keikkaCount/m3) does NOT affect it.",
      "GRID-ELIGIBLE (fb#776) = showInGrid set AND the day inside the vehicle's firstDate..lastDate window — a vehicle past its lastDate never reaches the board, so an EMPTY board means nothing qualifies that day, not 'no data'; the empty envelope's `hint` carries the counts.",
      VEHICLE_PLACEHOLDER_NOTE,
      DRIVER_DATE_NOTE,
      "Deploy-gated: 404 until puminet5api ships /api/cli/driver/*.",
    ],
    seeAlso: ["ib vehicle driver gaps", "ib vehicle driver available", "ib vehicle driver assign"],
    examples: [
      "ib vehicle driver board today",
      "ib vehicle driver board 2026-06-10",
      "ib vehicle driver board --date 2026-06-10",
    ],
  },
  {
    command: "ib vehicle driver gaps",
    description:
      "Vehicles needing a driver that day — the 'Ei kuljettajaa' list. Board rows filtered to needsDriver = the vehicle is configured with the no-driver bar AND has no day driver.",
    permissions: ["auth.page.grid.read"],
    args: [DRIVER_DATE_ARG],
    flags: [DRIVER_DATE_FLAG],
    outputShape:
      "ListEnvelope<{ vehicleId, plate, name, type, typeName, driverPersonId, driverName, hasDriver, needsDriver, keikkaCount, m3, placeholder? }>",
    errors: permErrors("auth.page.grid.read"),
    notes: [
      // The gap test is the vehicle's useNoDriverBar FLAG, not its workload —
      // keikkaCount/m3 are reported but do not gate needsDriver. Spelling that
      // out here because an empty gaps list beside a fully driverless board
      // reads as a contradiction otherwise (fb#380).
      "A driverless vehicle is NOT a gap unless it uses the no-driver bar — so an empty gaps list alongside a board full of driverless vehicles is expected, not a contradiction. keikkaCount/m3 are informational and do NOT affect needsDriver.",
      "EMPTY LIST DISAMBIGUATED (fb#776): the envelope `hint` says WHICH case holds — every grid-eligible vehicle already has a driver, vs NO vehicle is grid-eligible that day (usually an expired lastDate window — check `ib vehicle list`).",
      VEHICLE_PLACEHOLDER_NOTE,
      DRIVER_DATE_NOTE,
      "Pair with `ib vehicle driver available <date>` to find drivers to fill these. Deploy-gated.",
    ],
    seeAlso: ["ib vehicle driver available", "ib vehicle driver assign", "ib vehicle driver board"],
    examples: [
      "ib vehicle driver gaps today",
      "ib vehicle driver gaps tomorrow",
      "ib vehicle driver gaps --date tomorrow",
    ],
  },
  {
    command: "ib vehicle driver available",
    description:
      "Drivers free to assign that day — company pumpparit (asiakasPersonSettingTypeId 8) minus those already assigned to a vehicle that day minus those absent. The assignment candidate pool.",
    permissions: ["auth.page.grid.read"],
    args: [DRIVER_DATE_ARG],
    flags: [DRIVER_DATE_FLAG],
    outputShape: "ListEnvelope<{ personId, firstName, lastName, phone }>",
    errors: permErrors("auth.page.grid.read"),
    notes: [
      "Returns PEOPLE, not vehicles — the drivers you can hand to `assign`.",
      DRIVER_DATE_NOTE,
      "Absences are already excluded; for the raw away-list use `ib person absences`. Deploy-gated.",
    ],
    seeAlso: ["ib vehicle driver gaps", "ib vehicle driver assign", "ib person absences"],
    examples: [
      "ib vehicle driver available today",
      "ib vehicle driver available tomorrow",
      "ib vehicle driver available --date tomorrow",
    ],
  },
  {
    command: "ib vehicle driver who",
    description: "The day driver assigned to a single vehicle on a date (from personPvm), or null.",
    permissions: ["auth.page.grid.read"],
    args: [
      { name: "vehicleId", type: "number", description: "Target vehicleId" },
      DRIVER_DATE_ARG,
    ],
    flags: [DRIVER_DATE_FLAG],
    outputShape: "{ vehicleId, date, driver: { personId, firstName, lastName, phone } | null }",
    errors: permErrors("auth.page.grid.read"),
    notes: [
      "Returns driver:null (not 404) when no driver is assigned. For a date range use `ib vehicle driver history`. For the STANDING default see `ib vehicle driver default get`. Deploy-gated.",
      DRIVER_DATE_NOTE,
    ],
    seeAlso: ["ib vehicle driver history", "ib vehicle driver default get", "ib vehicle driver board"],
    examples: [
      "ib vehicle driver who 53 today",
      "ib vehicle driver who 53 2026-06-10",
      "ib vehicle driver who 53 --date 2026-06-10",
    ],
  },
  {
    command: "ib vehicle driver history",
    description:
      "Who was the DAY driver of one vehicle on each day of a range, sourced from personPvm (the live day-driver table) — NOT the legacy vehicleDriverDays. One row per day that had a driver.",
    permissions: ["auth.page.grid.read"],
    args: [{ name: "vehicleId", type: "number", description: "Target vehicleId" }],
    flags: [
      { name: "from", type: "date", description: "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "End date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
    ],
    outputShape: "ListEnvelope<{ date, personId, firstName, lastName, name }>",
    errors: [
      apiErr(400, "Bad from/to date", "use YYYY-MM-DD (or today/yesterday/tomorrow)"),
      ...permErrors("auth.page.grid.read"),
    ],
    notes: ["Per-day `ib vehicle driver who`, batched over a range. Deploy-gated (new /api/cli/driver/history route)."],
    seeAlso: ["ib vehicle driver who", "ib vehicle driver board"],
    examples: ["ib vehicle driver history 53 --from 2026-06-01 --to 2026-06-30"],
  },
  {
    command: "ib vehicle driver assign",
    description:
      "Set the DAY driver of a vehicle for a date. ATOMIC (the same transaction the web grid uses): writes personPvm.vehicleId AND the driver on every keikka (keikkaPerson) and palkki (palkkiPerson) on that vehicle that day, and relocates the driver off any other vehicle they held that day. Returns the full set of affected rows. Requires --reason.",
    permissions: ["auth.page.grid.tilaus.edit"],
    args: [
      { name: "vehicleId", type: "number", description: "Target vehicleId" },
      DRIVER_DATE_ARG,
    ],
    flags: [
      { name: "person", type: "number", description: "Driver personId", required: true },
      DRIVER_DATE_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success, vehicleId, date, personId, oldPersonId, oldDriverName, newDriverName, clearedFromVehicleId, keikkaIds, palkkiIds } | { dryRun:true, vehicleId, date, personId, oldPersonId, keikkaIds, palkkiIds, wouldClearFromVehicleId } (with --dry-run)",
    errors: [
      apiErr(400, "Missing/invalid field (no --reason, bad vehicle/person/date, or person not an eligible pumppari)", "supply --reason, valid ids, and a driver eligible for this company"),
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    notes: [
      "Requires Admin, HR Admin, or Keikka Handler on the active company. --reason is hard-required (exits 4 without it).",
      "Cascade: personPvm.vehicleId set for the driver; keikkaPerson driver (contactPersonTypeId=1) replaced on each affected keikka; palkkiPerson driver replaced on each affected palkki; the prior occupant of this vehicle (oldPersonId) is freed, and the new driver is pulled off any other vehicle (clearedFromVehicleId).",
      "Return reports exactly what changed: keikkaIds + palkkiIds touched, oldPersonId/oldDriverName displaced, newDriverName, clearedFromVehicleId.",
      "keikkaPerson rows are written with keikkaPersonSourceId=30; the grid's per-keikka-bar driver label filters sourceId=50, so the vehicle ROW shows the driver (via personPvm) but a reloaded keikka BAR may not — known display quirk shared with the web grid.",
      DRIVER_DATE_NOTE,
      "Emits the dayDriver:updated socket so live grids update. Deploy-gated (404 until /api/cli/driver/* ships).",
    ],
    seeAlso: ["ib vehicle driver gaps", "ib vehicle driver available", "ib vehicle driver clear", "ib vehicle driver default set"],
    examples: [
      "ib vehicle driver assign 53 tomorrow --person 555 --reason 'auto-fill'",
      "ib vehicle driver assign 53 today --person 555 --dry-run --reason preview",
      "ib vehicle driver assign 53 --date tomorrow --person 555 --reason 'auto-fill'",
    ],
  },
  {
    command: "ib vehicle driver clear",
    description:
      "Remove the DAY driver from a vehicle for a date (same atomic cascade as assign, personId=null): clears the driver from that day's keikkat/palkit and frees the person (personPvm.vehicleId=null) so they're available for other tasks. Returns what was cleared. Requires --reason.",
    permissions: ["auth.page.grid.tilaus.edit"],
    args: [
      { name: "vehicleId", type: "number", description: "Target vehicleId" },
      DRIVER_DATE_ARG,
    ],
    flags: [DRIVER_DATE_FLAG],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success, vehicleId, date, personId:null, oldPersonId, oldDriverName, newDriverName:null, clearedFromVehicleId:null, keikkaIds, palkkiIds } | { dryRun:true, ... } (with --dry-run)",
    errors: [
      apiErr(400, "Missing/invalid field (no --reason, bad vehicle/date)", "supply --reason and a valid vehicle"),
      ...permErrors("auth.page.grid.tilaus.edit"),
    ],
    notes: [
      "Requires Admin, HR Admin, or Keikka Handler on the active company. --reason is hard-required (exits 4 without it).",
      DRIVER_DATE_NOTE,
      "Use this when a driver breaks down / is pulled off — they become available again for `ib vehicle driver assign` elsewhere. Deploy-gated.",
    ],
    seeAlso: ["ib vehicle driver assign", "ib vehicle driver who"],
    examples: [
      "ib vehicle driver clear 53 today --reason 'breakdown — freed for other run'",
      "ib vehicle driver clear 53 --date today --reason 'breakdown — freed for other run'",
    ],
  },
  {
    command: "ib vehicle driver default get",
    aliases: ["ib vehicle driver default show"],
    description:
      "Read the vehicle's STANDING default driver (vehicle.defaultKuski_personId) — the template driver, distinct from the per-day driver. Projects the field off the vehicle record.",
    permissions: ["auth.page.vehicle.read"],
    args: [{ name: "vehicleId", type: "number", description: "Target vehicleId" }],
    flags: [],
    outputShape: "{ vehicleId, defaultDriverPersonId }",
    errors: [apiErr(404, "Vehicle not found", "verify vehicleId"), ...permErrors("auth.page.vehicle.read")],
    notes: ["defaultDriverPersonId is null when unset; resolve the name with `ib person get <id>`. For today's ACTUAL driver use `ib vehicle driver who`."],
    seeAlso: ["ib vehicle driver default set", "ib vehicle driver who"],
    examples: ["ib vehicle driver default get 53"],
  },
  {
    command: "ib vehicle driver default set",
    description:
      "Set the vehicle's STANDING default driver via /api/vehicle/setDefaultPumppari — the exact endpoint the FE 'Oletus pumppari' control uses. Cascades to FUTURE dates and returns a cascade summary. Requires --reason.",
    permissions: ["auth.page.vehicle.edit"],
    args: [{ name: "vehicleId", type: "number", description: "Target vehicleId" }],
    flags: [
      { name: "person", type: "number", description: "Default driver personId", required: true },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success, vehicleId, defaultDriverPersonId, cascade: { futureKeikkaIds, futureKeikkaCount, personPvmDaysUpdated } } | { dryRun:true, wouldUpdate } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason / bad ids", "supply --reason and a valid vehicleId/personId"),
      ...permErrors("auth.page.vehicle.edit"),
    ],
    notes: [
      "Cascade: sets vehicle.defaultKuski_personId; re-points the driver's EXISTING personPvm day-rows where pvm is AFTER today (active, pois=0; today EXCLUDED) to this vehicle; AND replaces the driver (keikkaPerson contactPersonTypeId=1, sourceId=30) on the vehicle's keikat from today 00:00 onward — so TODAY's later keikat ARE re-driven even though the personPvm half skips today. It does NOT create personPvm rows and does NOT touch palkit.",
      "cascade.personPvmDaysUpdated = future day-driver rows re-pointed; cascade.futureKeikkaIds/Count = future keikat updated.",
      "Same keikkaPersonSourceId=30 vs grid-bar-filter=50 display quirk as `ib vehicle driver assign`.",
      "This is the standing/template driver — for a single date use `ib vehicle driver assign`. Deploy-gated on the cascade-reporting proc (the write itself already works).",
    ],
    seeAlso: ["ib vehicle driver default get", "ib vehicle driver default clear", "ib vehicle driver assign"],
    examples: ['ib vehicle driver default set 53 --person 555 --reason "permanent driver"'],
  },
  {
    command: "ib vehicle driver default clear",
    description:
      "Clear the vehicle's STANDING default driver (setDefaultPumppari with personId=null): clears the column and removes the default driver from future keikat. Requires --reason.",
    permissions: ["auth.page.vehicle.edit"],
    args: [{ name: "vehicleId", type: "number", description: "Target vehicleId" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success, vehicleId, defaultDriverPersonId:null, cascade: { futureKeikkaIds, futureKeikkaCount, personPvmDaysUpdated } } | { dryRun:true, wouldUpdate } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason / bad id", "supply --reason and a valid vehicleId"),
      ...permErrors("auth.page.vehicle.edit"),
    ],
    notes: [
      "Clears vehicle.defaultKuski_personId and removes the driver (keikkaPerson contactPersonTypeId=1) from the vehicle's keikat from today 00:00 onward (today's later keikat included).",
      "Because the endpoint keys personPvm on the (now null) personId, clear does NOT re-point existing future personPvm rows — a prior default driver's already-set future day-driver rows remain until cleared per-day with `ib vehicle driver clear`. personPvmDaysUpdated is therefore 0 on a clear. Deploy-gated on the cascade-reporting proc.",
    ],
    seeAlso: ["ib vehicle driver default set", "ib vehicle driver clear"],
    examples: ['ib vehicle driver default clear 53 --reason "driver left"'],
  },
];
