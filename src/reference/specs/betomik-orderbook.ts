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
];
