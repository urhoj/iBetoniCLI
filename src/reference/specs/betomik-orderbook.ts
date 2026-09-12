import type { CommandSpec } from "../../output/help.js";
import { FROM_JSON_BODY_FLAG } from "./shared.js";

export const BETOMIK_ORDERBOOK_SPECS: CommandSpec[] = [
  {
    command: "ib dev betomik-orderbook import",
    description: "Bulk-load a parsed Betomik order-book run into the staging table for review before any real sync (developer only).",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    flags: [
      { name: "body", type: "json", required: true, description: "{ sheetLabel, isoYear, isoWeek, rows } — the parser's --json-out payload, forwarded verbatim" },
      FROM_JSON_BODY_FLAG,
    ],
    args: [],
    notes: [
      "The request body is read via --body/--from-json, NOT typed flags — it must be exactly {sheetLabel, isoYear, isoWeek, rows}, the shape parse-betomik-orderbook.py's --json-out writes.",
      "Each entry in rows is one job record from the parser's own output (source_type, plant_or_note, driver_name, etc.) — nothing here re-validates the parser's classification, it is stored as-is plus a server-side driver-name match.",
    ],
    outputShape: "{ importRunId, rowCount }",
    errors: [
      { http: 403, exit: 3, meaning: "Not a system admin or developer", remedy: "Only system admin/developer can trigger an import" },
      { http: 400, exit: 4, meaning: "Missing sheetLabel/isoYear/isoWeek/rows", remedy: "Pass a complete {sheetLabel, isoYear, isoWeek, rows} body" },
      { origin: "client", exit: 4, meaning: "No --body or --from-json payload given", remedy: "Pass --from-json <file|-> (the parser's json-out file) or --body '<json>'" },
    ],
    examples: [
      'ib dev betomik-orderbook import --from-json week40.json --reason "manual weekly import"',
    ],
  },
  {
    command: "ib dev betomik-orderbook runs",
    description: "List Betomik order-book import runs — sheet label, ISO year/week, row count, importedAt — newest first (GET /api/betomik-orderbook/runs). The week-selector for `rows`: pick the run whose isoYear/isoWeek match, latest importedAt if several.",
    tier: "developer",
    auth: "any",
    flags: [],
    args: [],
    outputShape: "ListEnvelope<{ importRunId, sheetLabel, isoYear, isoWeek, importedAt, importedBy, rowCount }>",
    errors: [
      { http: 403, exit: 3, meaning: "Not a system admin/developer and not an admin of the Betomik company", remedy: "Use a developer token, or an asiakasAdmin of asiakasId 27" },
    ],
    examples: ["ib dev betomik-orderbook runs"],
  },
  {
    command: "ib dev betomik-orderbook rows",
    description: "Staging rows of one import run (GET /api/betomik-orderbook/runs/:runId/rows) — jobDate, plate, vehicleLabel, driverName, driverMatchStatus, sourceType (betomik_self|third_party_plant|unspecified), plantOrNote, m3 (null when the sheet value was unparseable), reviewStatus. The read side of `import`; the weekly tenant report sums m3 and groups by plate from these rows.",
    tier: "developer",
    auth: "any",
    flags: [],
    args: [{ name: "runId", type: "number", description: "importRunId from `runs`" }],
    outputShape: "ListEnvelope<{ betomikOrderbookImportRowId, importRunId, jobDate, day, tableName, plate, vehicleLabel, driverRaw, driverName, matchedPersonId, driverMatchStatus, tehdasTilaaja, sourceType, plantOrNote, sourceAsiakasId, betomikBuys, betomikCrew, plantSijaintiId, plantOwnerAsiakasId, plantResolved, customerGuess, siteText, siteClassification, maybeNote, m3, reviewStatus, reviewedBy }>",
    errors: [
      { origin: "client", exit: 4, meaning: "runId is not a positive integer", remedy: "Pass the importRunId from `ib dev betomik-orderbook runs`" },
      { http: 400, exit: 4, meaning: "Backend rejected runId", remedy: "Pass a numeric importRunId" },
      { http: 403, exit: 3, meaning: "Not a system admin/developer and not an admin of the Betomik company", remedy: "Use a developer token, or an asiakasAdmin of asiakasId 27" },
    ],
    examples: ["ib dev betomik-orderbook rows 1"],
  },
];
