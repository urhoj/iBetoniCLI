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
];
