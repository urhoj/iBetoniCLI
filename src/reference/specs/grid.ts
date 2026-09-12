// grid specs — new domain (fb#1637 follow-up: Kalle Urho Oy palkki type
// replication for Betomik Oy surfaced that no `ib` capability existed for
// grid_palkkiTypes at all). Order within this file is load-bearing (catalogue
// order drives sibling-suggestion ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { authErrors, intParseErr, FROM_JSON_BODY_FLAG } from "./shared.js";

const PALKKI_TYPE_OWNER_ERR = intParseErr("--owner", "pass a non-negative ownerAsiakasId", 0);
const PALKKI_TYPE_SORTNO_ERR = intParseErr("--sort-no", "pass a non-negative integer", 0);

export const GRID_SPECS: CommandSpec[] = [
  {
    command: "ib grid palkki-type create",
    description:
      "Create a palkki type — a grid bar/annotation category (blocks a vehicle?, report visibility, auto-creates an inventory transfer?, billable job?). POST /api/grid/palkkiType/new. REQUIRED: --name. --owner defaults to your active company; ownerAsiakasId 0 is the SHARED catalog every company inherits and needs sysadmin/developer. Typed flags win over --body.",
    permissions: ["member of the target company (sysadmin/developer bypass; owner 0 requires sysadmin/developer)"],
    flags: [
      { name: "body", type: "json", description: "JSON body (optional if typed flags given) — PowerShell mangles inline quotes, use --from-json there." },
      { name: "name", type: "string", description: "grid_palkkiType (REQUIRED)" },
      { name: "description", type: "string", description: "grid_palkkiTypeDescription" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; 0 = shared catalog, sysadmin/developer only)" },
      { name: "inactive", type: "boolean", description: "active=false (default: active)" },
      { name: "vehicle-available", type: "boolean", description: "vehicleAvailable=true (default) — false blocks the vehicle for the day" },
      { name: "vehicle-unavailable", type: "boolean", description: "vehicleAvailable=false" },
      { name: "sort-no", type: "number", description: "Explicit sortNo (default: MAX(sortNo)+10)" },
      { name: "show-report-time", type: "boolean", description: "showReportKlo=true (default) — show start/end time on reports" },
      { name: "hide-report-time", type: "boolean", description: "showReportKlo=false" },
      { name: "report-style", type: "string", description: "reportStyle — CSS-in-JS fragment for the grid bar, e.g. 'fontWeight: \"bold\",'" },
      { name: "show-in-report", type: "boolean", description: "showInReport=true (default)" },
      { name: "hide-in-report", type: "boolean", description: "showInReport=false" },
      { name: "inventory-transfer", type: "boolean", description: "isInventoryTransfer=true (default: false) — auto-creates a delivery record" },
      { name: "job", type: "boolean", description: "isJob=true (default: false) — billable job type" },
      FROM_JSON_BODY_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success, rowsAffected, palkkiType } — null on --dry-run, which returns { dryRun:true, wouldCreate, validation } instead",
    errors: [
      PALKKI_TYPE_OWNER_ERR,
      PALKKI_TYPE_SORTNO_ERR,
      {
        origin: "client",
        exit: 4,
        match: "create requires:",
        meaning: "--name was not given (typed flag or --body)",
        remedy: "pass --name",
      },
      ...authErrors(),
    ],
    notes: [
      "A company with ZERO rows here is the norm, not a gap: every company inherits 4 shared types (owner 0). Only Kalle Urho Oy had custom ones as of 2026-09; this command lets another company adopt the same set.",
      "No list/update/delete yet — GET /grid/getStaticData ignores its :ownerAsiakasId param and only ever answers for the CALLER's active company. Verify another tenant's rows via `ib dev schema query` instead (developer-only).",
    ],
    examples: [
      'ib grid palkki-type create --name "betonitoimitus" --owner 27 --vehicle-available --show-report-time',
      "ib grid palkki-type create --body '{\"name\":\"HUOM\",\"ownerAsiakasId\":27}'",
    ],
  },
];
