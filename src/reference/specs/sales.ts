// sales specs — the betoni.online SaaS sales pipeline (system admin). Order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking), so append new commands at the end of the array.
import type { CommandSpec } from "../../output/help.js";
import { apiErr } from "./shared.js";

export const SALES_SPECS: CommandSpec[] = [
  {
    command: "ib sales prospect list",
    description:
      "List the betoni.online SaaS sales pipeline (dbo.saasProspect) — companies we are selling betoni.online ITSELF to. Distinct from `ib jerry admin onboarding list`, the BetoniJerry provider pipeline: a company sits in both at independent stages. Every filter is applied CLIENT-SIDE (the route takes no query params by design). Use --brief to drop the two long narrative columns.",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: "ei_aloitettu | analysoitu | kontaktoitu | tapaaminen | tarjous | voitettu | havitty | ei_sovellu" },
      { name: "tier", type: "number", description: "1 priority · 2 secondary · 3 long tail" },
      { name: "segment", type: "string", description: "pumppu | betoni | all | muu" },
      { name: "search", type: "string", description: "Case-insensitive substring over companyName + ytunnus + region" },
      { name: "brief", type: "boolean", description: "Omit analysis + pitchAngle — the full list is ~60 KB of narrative" },
    ],
    outputShape:
      "ListEnvelope<{ saasProspectId, asiakasId, companyName, ytunnus, status, tier, segment, region, fleetPumps, staffCount, revenueEur, revenueYear, currentSystem, fitScore, analysis, pitchAngle, parked, jerryStatus, analysisUpdatedTime, … }>",
    errors: [apiErr(403, "Not a system admin", "log in as a system admin")],
    examples: [
      "ib sales prospect list --brief --pretty",
      "ib sales prospect list --segment pumppu --status ei_aloitettu",
    ],
  },
  {
    command: "ib sales prospect get",
    description:
      "One SaaS prospect, by saasProspectId, --asiakas or --ytunnus. Exits 4 (not a guess) when more than one row matches the reference, and 5 when none does.",
    auth: "any",
    tier: "developer",
    args: [{ name: "saasProspectId", type: "number", description: "the row id (optional if --asiakas/--ytunnus given)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Look up by betoni.online asiakasId" },
      { name: "ytunnus", type: "string", description: "Look up by Finnish business id" },
    ],
    outputShape: "{ saasProspectId, asiakasId, companyName, status, analysis, … }",
    errors: [
      { origin: "client", exit: 4, meaning: "No reference given, or ambiguous match", remedy: "pass the saasProspectId" },
      { origin: "client", exit: 5, meaning: "No prospect matches", remedy: "`ib sales prospect list --search <name>`" },
    ],
    examples: ["ib sales prospect get --asiakas 27", "ib sales prospect get --ytunnus 1869376-5 --pretty"],
  },
  {
    command: "ib sales prospect add",
    description:
      "Add a company to the SaaS sales pipeline. --asiakas for a company already in betoni.online (companyName is backfilled from the asiakas row); --name for a COLD company with no asiakas row — which is the whole reason this pipeline has its own table.",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "asiakas", type: "number", description: "Existing betoni.online asiakasId" },
      { name: "name", type: "string", description: "Company name for a cold prospect (no asiakas row)" },
      { name: "ytunnus", type: "string", description: "Finnish business id" },
      { name: "segment", type: "string", description: "pumppu | betoni | all | muu" },
      { name: "tier", type: "number", description: "1 | 2 | 3" },
      { name: "region", type: "string", description: "Operating area (toimialue)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ saasProspectId }",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither --asiakas nor --name given", remedy: "pass one of them" },
      apiErr(400, "Prospect already exists for this company", "`ib sales prospect get --asiakas <id>`"),
      apiErr(403, "Not a system admin", "log in as a system admin"),
    ],
    examples: ['ib sales prospect add --asiakas 27 --segment pumppu --tier 1 --reason "seed"'],
  },
  {
    command: "ib sales prospect update",
    description:
      "Write company FACTS onto a SaaS prospect — the weekly suomen-betonipumppausyritykset task's write path. Only facts: the backend DROPS status/tier/notes/parkedUntil arriving here, because a human owns pipeline state and the task must never revert it. --fit-score and --pitch are FIRST-FILL: written only while the stored value is NULL, so a human's answer always wins. Stamps analysisUpdatedTime.",
    auth: "any",
    tier: "developer",
    args: [{ name: "saasProspectId", type: "number", description: "the row id (optional if --asiakas/--ytunnus given)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Resolve the row by asiakasId instead of the positional id" },
      { name: "ytunnus", type: "string", description: "Resolve the row by business id" },
      { name: "name", type: "string", description: "Company name" },
      { name: "segment", type: "string", description: "pumppu | betoni | all | muu" },
      { name: "region", type: "string", description: "Operating area" },
      { name: "fleet-pumps", type: "number", description: "Pump trucks" },
      { name: "staff", type: "number", description: "Employee count" },
      { name: "revenue", type: "number", description: "Revenue in EUR" },
      { name: "revenue-year", type: "number", description: "Which year the revenue figure is from" },
      { name: "current-system", type: "string", description: "Excel | Google Sheets | kilpailija | oma | ei tiedossa" },
      { name: "analysis", type: "string", description: "Narrative analysis (markdown). Long prose — use --from-json on Windows." },
      { name: "fit-score", type: "number", description: "1..5. FIRST-FILL only." },
      { name: "pitch", type: "string", description: "How to market to this company. FIRST-FILL only." },
      { name: "body", type: "string", description: "Inline JSON object of the same fields. Mutually exclusive with --from-json." },
      { name: "from-json", type: "string", description: "Read the fields from a JSON file (or - for stdin). The shell-safe route for long Finnish prose: PowerShell splits an argument on its inner double quotes and silently expands backticks. Use a FILE, not a pipe, for anything containing a backslash. Typed flags win over the document." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success: true }",
    errors: [
      { origin: "client", exit: 4, meaning: "No reference given, or ambiguous match", remedy: "pass the saasProspectId" },
      { origin: "client", exit: 5, meaning: "No prospect matches", remedy: "`ib sales prospect add` first" },
      apiErr(403, "Not a system admin", "log in as a system admin"),
    ],
    examples: [
      'ib sales prospect update --asiakas 27 --fleet-pumps 27 --staff 70 --reason "weekly registry sync"',
      'ib sales prospect update 12 --from-json ./analysis.json --reason "weekly registry sync"',
    ],
  },
  {
    command: "ib sales customer list",
    description:
      "Companies genuinely running work through betoni.online — those with their own keikka rows. NOT the same as 'has logged in' (59 companies have a login, 2 have keikkaa). lastLoginOwn excludes PumiNet Oy staff, who hold membership across numerous tenants; lastLoginAny is kept alongside so the difference is inspectable.",
    auth: "any",
    tier: "developer",
    flags: [],
    outputShape:
      "ListEnvelope<{ asiakasId, asiakasNimi, ytunnus, entryTime, lastActiveTime, keikat, firstKeikkaTime, lastKeikkaTime, vehicles, persons, lastLoginAny, lastLoginOwn }>",
    errors: [apiErr(403, "Not a system admin", "log in as a system admin")],
    examples: ["ib sales customer list --pretty"],
  },
];
