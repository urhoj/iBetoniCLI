// palkki specs — grid bars (grid_palkit) and their type catalogue
// (grid_palkkiTypes). Started life as `ib grid palkki-type create` (fb#1637
// follow-up, 2026-09-12) and was re-homed the same day so the CLI reads
// `ib keikka` / `ib palkki`. Order within this file is load-bearing (catalogue
// order drives sibling-suggestion ranking and the parse-guard-hint snapshots).
import type { CommandSpec, CommandFlag, CommandError } from "../../output/help.js";
import { apiErr, authErrors, intParseErr, FROM_JSON_BODY_FLAG } from "./shared.js";

const OWNER_PARSE_ERR = intParseErr("--owner", "pass a non-negative ownerAsiakasId", 0);
const SORT_NO_PARSE_ERR = intParseErr("--sort-no", "pass a non-negative integer", 0);
const BODY_FLAG: CommandFlag = {
  name: "body",
  type: "json",
  description: "JSON body (optional if typed flags given) — PowerShell mangles inline quotes, use --from-json there.",
};

const PALKKI_EDIT_ERRORS: CommandError[] = [
  apiErr(403, "No edit role in the bar's company (or, on delete/update, no such palkki — the owner lookup fails CLOSED)", "check `ib company` membership / role; verify the palkkiId with `ib palkki get`"),
  ...authErrors(),
];

/** Flags shared by `palkki create` and `palkki update` (all optional on update). */
function palkkiFlags(isUpdate: boolean): CommandFlag[] {
  return [
    BODY_FLAG,
    { name: "vehicle", type: "number", description: isUpdate ? "Move the bar to this vehicleId" : "vehicleId (REQUIRED)" },
    { name: "date", type: "string", description: isUpdate ? "Move to this day (YYYY-MM-DD | today | tomorrow)" : "Day: YYYY-MM-DD | today | tomorrow (default: today)" },
    { name: "start", type: "string", description: isUpdate ? "New start, HH:MM Helsinki" : "Start, HH:MM Helsinki wall-clock (default: 07:00)" },
    { name: "end", type: "string", description: isUpdate ? "New end, HH:MM Helsinki" : "End, HH:MM Helsinki wall-clock (default: 16:00)" },
    { name: "type", type: "string", description: isUpdate ? "Palkki type name or id" : "Palkki type name or id (REQUIRED) — see `ib palkki type list`" },
    { name: "text", type: "string", description: "Bar text" },
    { name: "keikka", type: "number", description: "attachedKeikkaId — link the bar to a keikka" },
    { name: "worksite", type: "number", description: "tyomaaId — destination for an inventory-transfer type" },
    { name: "owner", type: "number", description: isUpdate ? "Re-home to ownerAsiakasId (needs an edit role in BOTH companies)" : "ownerAsiakasId (default: active company)" },
    { name: "style", type: "string", description: "style — CSS-in-JS fragment for this bar" },
    FROM_JSON_BODY_FLAG,
  ];
}

/** Flags shared by `palkki type create` and `palkki type update`. */
function palkkiTypeFlags(isUpdate: boolean): CommandFlag[] {
  const dflt = (s: string) => (isUpdate ? "" : s);
  return [
    BODY_FLAG,
    { name: "name", type: "string", description: isUpdate ? "grid_palkkiType" : "grid_palkkiType (REQUIRED)" },
    { name: "description", type: "string", description: "grid_palkkiTypeDescription" },
    { name: "owner", type: "number", description: isUpdate ? "Move to ownerAsiakasId (a company you belong to)" : "ownerAsiakasId (default: active company; 0 = shared catalog, sysadmin/developer only)" },
    ...(isUpdate ? [{ name: "active", type: "boolean", description: "active=true" } as CommandFlag] : []),
    { name: "inactive", type: "boolean", description: `active=false${dflt(" (default: active)")}` },
    { name: "vehicle-available", type: "boolean", description: `vehicleAvailable=true${dflt(" (default)")} — false blocks the vehicle for the day` },
    { name: "vehicle-unavailable", type: "boolean", description: "vehicleAvailable=false" },
    { name: "sort-no", type: "number", description: isUpdate ? "sortNo" : "Explicit sortNo (default: MAX(sortNo)+10)" },
    { name: "show-report-time", type: "boolean", description: `showReportKlo=true${dflt(" (default)")} — show start/end time on reports` },
    { name: "hide-report-time", type: "boolean", description: "showReportKlo=false" },
    { name: "report-style", type: "string", description: "reportStyle — CSS-in-JS fragment for the grid bar, e.g. 'fontWeight: \"bold\",'" },
    { name: "show-in-report", type: "boolean", description: `showInReport=true${dflt(" (default)")}` },
    { name: "hide-in-report", type: "boolean", description: "showInReport=false" },
    { name: "inventory-transfer", type: "boolean", description: `isInventoryTransfer=true${dflt(" (default: false)")} — auto-creates a delivery record` },
    ...(isUpdate ? [{ name: "no-inventory-transfer", type: "boolean", description: "isInventoryTransfer=false" } as CommandFlag] : []),
    { name: "job", type: "boolean", description: `isJob=true${dflt(" (default: false)")} — billable job type` },
    ...(isUpdate ? [{ name: "no-job", type: "boolean", description: "isJob=false" } as CommandFlag] : []),
    FROM_JSON_BODY_FLAG,
  ];
}

const pairErr = (isUpdate: boolean): CommandError => ({
  origin: "client",
  exit: 4,
  match: "Pass at most one of",
  meaning: "Both halves of an on/off flag pair were given",
  remedy: `pass only one of --vehicle-available/--vehicle-unavailable, --show-report-time/--hide-report-time, --show-in-report/--hide-in-report${isUpdate ? ", --active/--inactive" : ""}`,
});

/** Flags shared by `palkki color create` and `palkki color update`. */
function palkkiColorFlags(isUpdate: boolean): CommandFlag[] {
  return [
    BODY_FLAG,
    { name: "title", type: "string", description: isUpdate ? "title" : "title (REQUIRED)" },
    { name: "ehto", type: "string", description: "ehto — the keikkaEval condition this rule matches against a keikka; evaluated by the web grid only (no local or server-side syntax check)" },
    { name: "style", type: "string", description: 'style — CSS-in-JS fragment applied to the grid bar, e.g. \'backgroundColor: "#f44336",\'' },
    { name: "comment", type: "string", description: "comment — free-text note, not shown in the grid" },
    { name: "sort-no", type: "number", description: "sortNo — evaluation order (first matching active rule wins); default: the row's own id" },
    { name: "owner", type: "number", description: isUpdate ? "Move to ownerAsiakasId (a company you belong to)" : "ownerAsiakasId (default: active company; 0 = shared catalog, sysadmin/developer only)" },
    { name: "icon-name", type: "string", description: "iconName — icon shown on the bar when this rule matches" },
    { name: "icon-text", type: "string", description: "iconText — 1-2 letters (e.g. BV) shown in the bar's circle INSTEAD of the icon when set; empty string clears" },
    { name: "icon-color", type: "string", description: "iconColor" },
    { name: "icon-background-color", type: "string", description: "iconBackgroundColor" },
    ...(isUpdate ? [{ name: "active", type: "boolean", description: "isActive=true" } as CommandFlag] : []),
    { name: "inactive", type: "boolean", description: `isActive=false${isUpdate ? "" : " (default: active)"}` },
    FROM_JSON_BODY_FLAG,
  ];
}

const palkkiColorPairErr: CommandError = {
  origin: "client",
  exit: 4,
  match: "Pass at most one of --active / --inactive",
  meaning: "Both halves of the --active/--inactive pair were given",
  remedy: "pass only one of --active / --inactive",
};

const PALKKI_COLOR_ROW_SHAPE =
  "{ barColorId, title, ehto, style, comment, sortNo, ownerAsiakasId, isActive, iconName, iconText, iconColor, iconBackgroundColor }";

/**
 * Not-found on a bar-coloring rule has TWO origins on create/update/delete:
 * the CLI's own client-side lookup (no "get one" endpoint exists — `get`,
 * and every --dry-run preview, resolve by listing the owner and filtering)
 * answers exit 5 locally; the LIVE (non-dry-run) write hits the real backend
 * route, which now also 404s a missing id for real (fb#1694 fix).
 */
const PALKKI_COLOR_CLIENT_NOT_FOUND: CommandError = {
  origin: "client",
  exit: 5,
  match: "not found for owner",
  meaning: "No such barColorId in the resolved owner's list (client-side lookup — used by get and every --dry-run preview)",
  remedy: "check the id with `ib palkki color list`, or pass --owner",
};
const PALKKI_COLOR_NOT_FOUND_ERRORS: CommandError[] = [
  PALKKI_COLOR_CLIENT_NOT_FOUND,
  apiErr(404, "No such bar-coloring rule (live write only — the client-side lookup above catches this earlier for get/--dry-run)", "verify the id with `ib palkki color list`"),
];

const PALKKI_COLOR_OWNER_ERRORS: CommandError[] = [
  OWNER_PARSE_ERR,
  apiErr(403, "Not a member of the owning company (or, on update, of the NEW --owner when re-homing) — sysadmin/developer bypass; owner 0 requires sysadmin/developer", "check `ib company`"),
];

/** Parse rows for the four integer flags `palkki create|update` share. */
const PALKKI_INT_ERRORS: CommandError[] = [
  intParseErr("--vehicle", "pass a positive vehicleId"),
  intParseErr("--keikka", "pass a positive keikkaId"),
  intParseErr("--worksite", "pass a positive tyomaaId"),
  intParseErr("--owner", "pass a positive ownerAsiakasId"),
];

const PALKKI_ROW_SHAPE =
  "{ palkkiId, date, start, end (Helsinki HH:MM), timeStart, timeEnd (ISO), vehicleId, typeId, typeName, text, style, ownerAsiakasId, sourceAsiakasId, attachedKeikkaId, deleted }";

export const PALKKI_SPECS: CommandSpec[] = [
  {
    command: "ib palkki list",
    description:
      "Palkit (grid bars) of one company overlapping a day or a date range — optionally one vehicle. GET /api/cli/palkki/list. Soft-deleted bars are excluded unless --deleted. Max range 62 days.",
    permissions: ["member of the target company (sysadmin/developer bypass)"],
    flags: [
      { name: "date", type: "string", description: "One day: YYYY-MM-DD | today | tomorrow (default: today)" },
      { name: "from", type: "string", description: "Range start (YYYY-MM-DD)" },
      { name: "to", type: "string", description: "Range end (YYYY-MM-DD, default: --from)" },
      { name: "vehicle", type: "number", description: "Only this vehicleId" },
      { name: "owner", type: "number", description: "Company whose palkit to list (default: active company)" },
      { name: "source", type: "number", description: "Also include bars whose sourceAsiakasId is this company (cross-tenant drops)" },
      { name: "deleted", type: "boolean", description: "Include soft-deleted bars (deleted:true)" },
    ],
    outputShape: `{ items: ${PALKKI_ROW_SHAPE}[], count, nextCursor: null }`,
    errors: [
      { origin: "client", exit: 4, match: "either --date or --from/--to", meaning: "--date combined with --from/--to", remedy: "pass one form" },
      { origin: "client", exit: 4, match: "--to needs --from", meaning: "--to given without --from (would otherwise silently collapse to today)", remedy: "pass --from <date> too, or --date for one day" },
      intParseErr("--vehicle", "pass a positive vehicleId"),
      intParseErr("--owner", "pass a positive ownerAsiakasId"),
      intParseErr("--source", "pass a positive asiakasId"),
      apiErr(400, "Bad date, to < from, or range over 62 days", "fix the dates"),
      apiErr(403, "--owner is not a company you belong to", "check `ib company`"),
      ...authErrors(),
    ],
    notes: [
      "Overlap semantics: a bar is listed on every day it touches (starttime < dayEnd AND endtime > dayStart), unlike the web grid proc which drops bars crossing the window.",
      "Driver on a bar is NOT projected here — `ib vehicle driver board <date>` shows the day driver per vehicle.",
    ],
    seeAlso: ["ib palkki get", "ib palkki create", "ib vehicle driver board"],
    examples: ["ib palkki list --date tomorrow", "ib palkki list --from 2026-09-14 --to 2026-09-20 --vehicle 53"],
  },
  {
    command: "ib palkki get",
    aliases: ["ib palkki show"],
    description: "One palkki by id (GET /api/cli/palkki/get/:id). 404 unless its owner OR source company is one you belong to.",
    permissions: ["member of the bar's owner or source company (sysadmin/developer bypass)"],
    args: [{ name: "palkkiId", type: "number", description: "grid_palkki_Id" }],
    flags: [],
    outputShape: PALKKI_ROW_SHAPE,
    errors: [
      apiErr(404, "Palkki not found OR outside your companies", "verify the id — a foreign tenant's bar 404s identically"),
      ...authErrors(),
    ],
    examples: ["ib palkki get 4821"],
  },
  {
    command: "ib palkki create",
    description:
      "Create a grid bar on a vehicle-day. POST /api/cli/palkki/create. REQUIRED: --vehicle, --type; --date defaults to today, --start/--end to 07:00–16:00 Helsinki. The type is resolved by NAME within the owner company (+ the shared owner-0 catalogue); a miss 400s listing the valid names. The bar's day driver is auto-assigned from the vehicle's personPvm, exactly like the web grid.",
    permissions: ["edit role in the owner company (requireCompanyRole tier edit)"],
    flags: palkkiFlags(false),
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ ..., savedPalkki: { palkkiId, starttime, endtime, vehicleId, text, ownerAsiakasId, grid_palkkiTypeId, ... } } — --dry-run returns { dryRun:true, wouldCreate: <normalised body>, validation }",
    errors: [
      { origin: "client", exit: 4, match: "create requires:", meaning: "--vehicle / --type / times missing (typed flag or --body)", remedy: "pass --vehicle and --type (times default)" },
      { origin: "client", exit: 4, match: "expected HH:MM", meaning: "--start/--end not HH:MM", remedy: "pass e.g. --start 07:30" },
      ...PALKKI_INT_ERRORS,
      apiErr(400, "Unknown palkki type for the owner company (the message lists valid names), timeStart >= timeEnd, or a missing field", "pick a name from `ib palkki type list`; create one with `ib palkki type create`"),
      ...PALKKI_EDIT_ERRORS,
    ],
    notes: [
      "Times are Helsinki wall-clock composed into ISO instants client-side (DST-correct, same as every --time flag); the backend stores the instants exactly as the web grid does.",
      "Assigning a specific driver is a separate step: `ib vehicle driver assign <vehicleId> <date> --person <id>` updates personPvm + keikkaPerson + palkkiPerson together.",
    ],
    seeAlso: ["ib palkki type list", "ib palkki list", "ib vehicle driver assign"],
    examples: [
      'ib palkki create --vehicle 53 --date tomorrow --type huolto --text "Öljynvaihto" --reason "huoltokirja"',
      "ib palkki create --vehicle 53 --type kommentti --start 12:00 --end 14:00 --dry-run",
    ],
  },
  {
    command: "ib palkki update",
    description:
      "PARTIAL update of a grid bar — only the flags you pass change (the backend read-merges over the row). POST /api/cli/palkki/update/:id. A time move (--date/--start/--end) reads the current bar first to fill the components you did not pass.",
    permissions: ["edit role in the bar's company (and in --owner's, when re-homing)"],
    args: [{ name: "palkkiId", type: "number", description: "grid_palkki_Id" }],
    flags: palkkiFlags(true),
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ..., savedPalkki } — --dry-run returns { dryRun:true, wouldUpdate: <merged body>, validation }",
    errors: [
      { origin: "client", exit: 4, match: "Nothing to update", meaning: "No field flags and no --body", remedy: "pass at least one field flag" },
      { origin: "client", exit: 4, match: "expected HH:MM", meaning: "--start/--end not HH:MM", remedy: "pass e.g. --end 12:00" },
      ...PALKKI_INT_ERRORS,
      apiErr(404, "Palkki not found, soft-deleted, or outside your companies", "verify with `ib palkki get`"),
      apiErr(400, "Unknown palkki type, or timeStart >= timeEnd after the merge", "check `ib palkki type list` / the times"),
      ...PALKKI_EDIT_ERRORS,
    ],
    seeAlso: ["ib palkki get", "ib log entity"],
    examples: ['ib palkki update 4821 --end 12:00 --reason "lyhennetty"', "ib palkki update 4821 --vehicle 54 --dry-run"],
  },
  {
    command: "ib palkki delete",
    description: "Soft-delete a grid bar (sets deletedTime; DELETE /api/cli/palkki/delete/:id). Broadcasts palkki:deleted to open grids.",
    permissions: ["edit role in the bar's company"],
    args: [{ name: "palkkiId", type: "number", description: "grid_palkki_Id" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ deleted: true, palkkiId } — --dry-run returns { dryRun:true, wouldDelete:{ palkkiId }, validation }",
    errors: PALKKI_EDIT_ERRORS,
    notes: ["A bar that does not exist answers 403, not 404: the tenant gate resolves the owner first and fails closed."],
    examples: ['ib palkki delete 4821 --reason "duplicate"'],
  },
  {
    command: "ib palkki type list",
    description:
      "Palkki types one company can use: its own rows plus the shared catalogue (owner 0). GET /api/cli/palkki/type/list. Active only unless --all. The `grid_palkkiType` name is what `ib palkki create --type` takes.",
    permissions: ["member of the target company (sysadmin/developer bypass)"],
    flags: [
      { name: "owner", type: "number", description: "Company (default: active company)" },
      { name: "all", type: "boolean", description: "Include inactive types" },
    ],
    outputShape:
      "{ items: { grid_palkkiTypeId, grid_palkkiType, grid_palkkiTypeDescription, active, ownerAsiakasId, vehicleAvailable, sortNo, showReportKlo, reportStyle, showInReport, isInventoryTransfer, isJob }[], count, nextCursor: null }",
    errors: [
      intParseErr("--owner", "pass a positive ownerAsiakasId"),
      apiErr(403, "--owner is not a company you belong to", "check `ib company`"),
      ...authErrors(),
    ],
    examples: ["ib palkki type list", "ib palkki type list --owner 27 --all"],
  },
  {
    command: "ib palkki type create",
    description:
      "Create a palkki type — a grid bar/annotation category (blocks a vehicle?, report visibility, auto-creates an inventory transfer?, billable job?). POST /api/grid/palkkiType/new. REQUIRED: --name. --owner defaults to your active company; ownerAsiakasId 0 is the SHARED catalog every company inherits and needs sysadmin/developer. Typed flags win over --body.",
    permissions: ["member of the target company (sysadmin/developer bypass; owner 0 requires sysadmin/developer)"],
    flags: palkkiTypeFlags(false),
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success, rowsAffected, palkkiType } — null on --dry-run, which returns { dryRun:true, wouldCreate, validation } instead",
    errors: [
      OWNER_PARSE_ERR,
      SORT_NO_PARSE_ERR,
      { origin: "client", exit: 4, match: "create requires:", meaning: "--name was not given (typed flag or --body)", remedy: "pass --name" },
      pairErr(false),
      ...authErrors(),
    ],
    notes: [
      "A company with ZERO rows here is the norm, not a gap: every company inherits 4 shared types (owner 0). Only Kalle Urho Oy had custom ones as of 2026-09; this command lets another company adopt the same set.",
    ],
    seeAlso: ["ib palkki type list", "ib palkki create"],
    examples: [
      'ib palkki type create --name "betonitoimitus" --owner 27 --vehicle-available --show-report-time',
      "ib palkki type create --body '{\"name\":\"HUOM\",\"ownerAsiakasId\":27}'",
    ],
  },
  {
    command: "ib palkki type update",
    description:
      "PARTIAL update of a palkki type — only the flags you pass change (the backend read-merges over the row). POST /api/grid/palkkiType/save/:id. Same flag vocabulary as create plus --active / --no-inventory-transfer / --no-job to switch a boolean off.",
    permissions: ["member of the owning company (sysadmin/developer bypass; owner 0 requires sysadmin/developer)"],
    args: [{ name: "palkkiTypeId", type: "number", description: "grid_palkkiTypeId" }],
    flags: palkkiTypeFlags(true),
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success, rowsAffected, palkkiType: <merged row> } — --dry-run returns { dryRun:true, wouldUpdate: <merged row>, validation }",
    errors: [
      { origin: "client", exit: 4, match: "Nothing to update", meaning: "No field flags and no --body", remedy: "pass at least one field flag" },
      OWNER_PARSE_ERR,
      SORT_NO_PARSE_ERR,
      pairErr(true),
      apiErr(404, "Palkki type not found", "verify the id with `ib palkki type list`"),
      apiErr(403, "Not a member of the owning company / of --owner", "check `ib company`"),
      ...authErrors(),
    ],
    examples: ['ib palkki type update 1000 --description "Huoltopäivä" --hide-in-report', "ib palkki type update 1000 --inactive --dry-run"],
  },
  {
    command: "ib palkki type delete",
    description: "Delete a palkki type (DELETE /api/grid/palkkiType/delete/:id). Refused while any grid_palkit row still references it — deactivate with `ib palkki type update <id> --inactive` instead.",
    permissions: ["member of the owning company (sysadmin/developer bypass; owner 0 requires sysadmin/developer)"],
    args: [{ name: "palkkiTypeId", type: "number", description: "grid_palkkiTypeId" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success, rowsAffected } or { success:false, message } when still referenced — --dry-run returns { dryRun:true, wouldDelete:{ grid_palkkiTypeId }, validation }",
    errors: [
      apiErr(404, "Palkki type not found", "verify the id with `ib palkki type list`"),
      apiErr(403, "Not a member of the owning company", "check `ib company`"),
      ...authErrors(),
    ],
    notes: ["--dry-run checks existence + membership only; the 'still referenced' refusal is evaluated on the live call and comes back as success:false (exit 0)."],
    examples: ['ib palkki type delete 1003 --reason "luotu vahingossa"'],
  },
  {
    command: "ib palkki color list",
    description:
      "Bar-coloring rules ('Palkkiväritykset' in Grid settings) one company can use — condition-based coloring/icon rules for grid bars, evaluated client-side (keikkaEval on `ehto`) by the web grid. Distinct from `ib palkki type` ('Palkkilajit'). GET /api/grid/barColors/list/:owner (bare array, projected here).",
    permissions: ["membership or view-tier role on the owner (requireAsiakasReadAccess; sysadmin/developer bypass)"],
    flags: [{ name: "owner", type: "number", description: "Company whose bar-coloring rules to list (default: active company)" }],
    outputShape: `{ items: ${PALKKI_COLOR_ROW_SHAPE}[], count, nextCursor: null }`,
    errors: [
      OWNER_PARSE_ERR,
      apiErr(403, "--owner is not a company you belong to (or hold a view-tier role over)", "check `ib company`"),
      ...authErrors(),
    ],
    notes: ["Rows are NOT paginated by the backend — the whole owner's set comes back in one call; typically a handful of rules."],
    seeAlso: ["ib palkki color get", "ib palkki color create", "ib palkki type list"],
    examples: ["ib palkki color list", "ib palkki color list --owner 27"],
  },
  {
    command: "ib palkki color get",
    aliases: ["ib palkki color show"],
    description: "One bar-coloring rule by id. No backend 'get one' route exists — resolved by listing the owner and filtering client-side.",
    permissions: ["same as `ib palkki color list` for the resolved --owner"],
    args: [{ name: "barColorId", type: "number", description: "grid_barColors.barColorId" }],
    flags: [{ name: "owner", type: "number", description: "Company to look the row up under (default: active company)" }],
    outputShape: PALKKI_COLOR_ROW_SHAPE,
    errors: [OWNER_PARSE_ERR, PALKKI_COLOR_CLIENT_NOT_FOUND, apiErr(403, "--owner is not a company you belong to", "check `ib company`"), ...authErrors()],
    examples: ["ib palkki color get 12", "ib palkki color get 12 --owner 27"],
  },
  {
    command: "ib palkki color create",
    description:
      "Create a bar-coloring rule. POST /api/grid/barColors/save with no barColorId (a true upsert — the backend's INSERT branch). REQUIRED: --title. --owner defaults to your active company; 0 is the shared/global catalog (sysadmin/developer only). No server-side X-Dry-Run support on this route, so --dry-run resolves entirely CLIENT-SIDE (the write is never sent).",
    permissions: ["member of the target company (sysadmin/developer bypass; owner 0 requires sysadmin/developer) — fb#1694"],
    flags: palkkiColorFlags(false),
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ barColorId, barColor: <saved row> } — --dry-run returns { dryRun:true, wouldCreate: <body> } without sending any request",
    errors: [
      { origin: "client", exit: 4, match: "create requires:", meaning: "--title was not given (typed flag or --body)", remedy: "pass --title" },
      SORT_NO_PARSE_ERR,
      ...PALKKI_COLOR_OWNER_ERRORS,
      ...authErrors(),
    ],
    notes: [
      "--reason is accepted (the write-safety trio) but currently has no effect: bar colors carry no ChangeTracker audit trail, unlike `ib palkki`/`ib palkki type`.",
      "ehto is free text, matched by the web grid's keikkaEval formula engine — there is no CLI or backend syntax check; a malformed expression is accepted here and simply never matches (or errors silently) in the grid.",
    ],
    seeAlso: ["ib palkki color list", "ib palkki color update", "ib palkki type create"],
    examples: [
      'ib palkki color create --title "Myöhässä" --ehto "keikka.late" --style \'backgroundColor: "#f44336",\' --icon-name warning',
      'ib palkki color create --title "Testi" --dry-run',
    ],
  },
  {
    command: "ib palkki color update",
    description:
      "PARTIAL update of a bar-coloring rule — only the flags you pass change (the backend read-merges over the row, same route as create: POST /api/grid/barColors/save with barColorId set). --dry-run resolves CLIENT-SIDE: it looks the row up under the ACTIVE company (an --owner on this command re-homes the row and is NOT used to locate it for the preview) and previews the merge without sending anything.",
    permissions: ["member of the row's owning company (sysadmin/developer bypass; owner 0 requires sysadmin/developer) — fb#1694"],
    args: [{ name: "barColorId", type: "number", description: "grid_barColors.barColorId" }],
    flags: palkkiColorFlags(true),
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ barColorId, barColor: <merged row> } — --dry-run returns { dryRun:true, wouldUpdate: <merged row> } without sending any request",
    errors: [
      { origin: "client", exit: 4, match: "Nothing to update", meaning: "No field flags and no --body", remedy: "pass at least one field flag" },
      SORT_NO_PARSE_ERR,
      palkkiColorPairErr,
      ...PALKKI_COLOR_NOT_FOUND_ERRORS,
      ...PALKKI_COLOR_OWNER_ERRORS,
      ...authErrors(),
    ],
    notes: ["--reason is accepted but has no effect — see `ib palkki color create`'s notes."],
    seeAlso: ["ib palkki color get"],
    examples: ['ib palkki color update 12 --style \'backgroundColor: "#4caf50",\'', "ib palkki color update 12 --title Testi --dry-run"],
  },
  {
    command: "ib palkki color delete",
    description: "Delete a bar-coloring rule (soft delete — sets isDeleted; DELETE /api/grid/barColors/delete/:id, same shape as `ib palkki delete`'s deletedTime). --dry-run resolves CLIENT-SIDE (a local lookup under --owner, default active company; no DELETE is issued).",
    permissions: ["member of the row's owning company (sysadmin/developer bypass; owner 0 requires sysadmin/developer) — fb#1694"],
    args: [{ name: "barColorId", type: "number", description: "grid_barColors.barColorId" }],
    flags: [{ name: "owner", type: "number", description: "Company to look the row up under for --dry-run (default: active company); ignored on a live delete" }],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ success: true } — --dry-run returns { dryRun:true, wouldDelete:{ barColorId } } without sending any request",
    errors: [OWNER_PARSE_ERR, ...PALKKI_COLOR_NOT_FOUND_ERRORS, apiErr(403, "Not a member of the row's owning company", "check `ib company`"), ...authErrors()],
    notes: ["Soft delete: sets isDeleted, filtered out of `ib palkki color list`/`get` thereafter — not a hard delete."],
    examples: ['ib palkki color delete 12 --reason "duplicate"', "ib palkki color delete 12 --dry-run"],
  },
  {
    command: "ib palkki color reorder",
    description:
      "Swap sortNo between two bar-coloring rules (the FE's adjacent up/down reorder). POST /api/grid/barColors/reorder blindly assigns whatever sortNo it is given — no server-side lookup — so the CLI resolves both rows' CURRENT sortNo first (same client-side lookup as `get`, under one shared --owner) and sends the swap. --dry-run resolves the same lookup and previews without sending the POST.",
    permissions: ["member of the shared owning company for BOTH ids (sysadmin/developer bypass; owner 0 requires sysadmin/developer) — fb#1694"],
    args: [
      { name: "barColorId1", type: "number", description: "grid_barColors.barColorId" },
      { name: "barColorId2", type: "number", description: "grid_barColors.barColorId" },
    ],
    flags: [{ name: "owner", type: "number", description: "Company both rows belong to (default: active company)" }],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ success: true } — --dry-run returns { dryRun:true, wouldReorder:{ barColorId1, sortNo1, barColorId2, sortNo2 } } without sending any request",
    errors: [
      OWNER_PARSE_ERR,
      { origin: "client", exit: 5, match: "not found for owner", meaning: "Either id is not in the resolved --owner's list — including two rows that legitimately belong to DIFFERENT companies, which this local lookup cannot tell apart from a bad id", remedy: "verify both ids with `ib palkki color list --owner <id>`; a cross-company swap is refused either way (also enforced server-side, fb#1694)" },
      apiErr(403, "Not a member of the shared owning company", "check `ib company`"),
      ...authErrors(),
    ],
    seeAlso: ["ib palkki color list", "ib palkki color get"],
    examples: ["ib palkki color reorder 12 13", "ib palkki color reorder 12 13 --owner 27 --dry-run"],
  },
];
