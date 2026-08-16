/**
 * Catalogue of every `ib` subcommand for v1.0.
 *
 * Each entry is a {@link CommandSpec} consumed by:
 *  - `src/output/help.ts`  → renders `--help` for the matching subcommand;
 *  - `src/reference/dump.ts` → emits the entire surface as JSON via
 *    `ib reference dump`, the single document an AI assistant ingests to
 *    learn the CLI in one shot.
 *
 * Keeping the catalogue in one file means human help and the machine
 * reference share a single source of truth — there is no separate doc to
 * drift. Errors codes follow the universal exit-code map:
 *   401 = token expired (remedy: `ib auth refresh`)
 *   403 = permission denied (remedy: check the listed `auth.page.*`)
 *   404 = not found
 *   400 = validation
 *   500 = backend error
 */
import type { CommandArg, CommandError, CommandFlag, CommandSpec } from "../output/help.js";
import { exitCodeFromStatus } from "../api/errors.js";
// `ib message daily` / `ib message board` specs are co-located with their
// commands (one source of truth per sub-group) and spread in at the end of
// COMMAND_SPECS.
import { MESSAGE_DAILY_SPECS } from "../commands/message/daily/index.js";
import { MESSAGE_BOARD_SPECS } from "../commands/message/board/index.js";
import { CHANGELOG_SPECS } from "../commands/changelog/index.js";
import {
  ONBOARDING_STATUS_KEYS,
  ONBOARDING_STATUSES,
  CHECK_ADDRESS_GATES,
  REQUEST_STATS_GROUPS,
  PROVIDER_LIST_TABS,
  ADMIN_REQUEST_STATUSES,
  SEARCH_DELIVERABLE,
  COMPANY_TYPES,
  ONBOARDING_SOURCES,
  ONBOARDING_EVENT_TYPES,
  ONBOARDING_EVENT_TYPES_ALL,
  ONBOARDING_EVENT_BODY_CAP,
} from "../commands/jerry/index.js";
import {
  KINDS as FEEDBACK_KINDS,
  SCOPES as FEEDBACK_SCOPES,
  STATUSES as FEEDBACK_STATUSES,
  SEVERITIES as FEEDBACK_SEVERITIES,
} from "../commands/feedback/index.js";
import { EXECUTORS as TASK_EXECUTORS, AGENTS as TASK_AGENTS } from "../commands/task/index.js";

/**
 * The empty-string CLEAR convention, carrying its PowerShell caveat.
 *
 * `clearHint` is the terse per-FLAG form; `clearNote` the sentence-level one for
 * a command description that explains the convention once. Helpers rather than
 * ~15 hand-copied sentences: the caveat existed on NONE of the sites when fb#634
 * was filed, and duplicated prose is precisely what drifts next time. Callers
 * concatenate rather than interpolate so the surrounding descriptions keep their
 * existing quoting (several contain backticks, which a template literal would
 * force us to escape). Long form: `ib help shell-quoting`.
 */
const clearHint = (flag: string) =>
  `pass "" to clear — PowerShell DROPS a bare "", so use \`${flag}=\` there (same meaning in bash; \`ib help shell-quoting\`)`;

const clearNote = (flag: string) =>
  `On Windows PowerShell a bare "" is DROPPED and the NEXT flag silently becomes the value — use the equals form \`${flag}=\` there, which means the same thing in bash (\`ib help shell-quoting\`).`;

/**
 * API error row: derive the exit code from the HTTP status.
 *
 * `match` (optional, ANY-of) narrows the row to ONE cause behind a status that
 * has several — `hintForError` prefers a matching row over the status's
 * catch-all (fb#485). List the narrow rows BEFORE the catch-all for readability;
 * order does not decide the winner, the substring hit does.
 */
const apiErr = (
  http: number,
  meaning: string,
  remedy: string,
  match?: string | string[]
): CommandError => ({
  http,
  exit: exitCodeFromStatus(http),
  meaning,
  remedy,
  ...(match === undefined ? {} : { match }),
});

/**
 * Sandwich the command-specific rows between the universal 401 and 500 rows,
 * preserving their order. Most specs' custom rows (403/404/…) belong BETWEEN
 * the two, which `...COMMON_AUTH_ERRORS` (a trailing spread) cannot express.
 */
const authErrors = (...rows: CommandError[]): CommandError[] => [
  apiErr(401, "Token expired", "ib auth refresh"),
  ...rows,
  apiErr(500, "Backend error", "retry with --verbose"),
];

/**
 * Errors that apply to every authenticated command. Exported so
 * `ib reference dump` can hoist them into a single top-level `commonErrors`
 * block and strip the (identical) per-spec copies — they otherwise repeat
 * verbatim in ~240 specs and are the single largest field in the dump.
 */
export const COMMON_AUTH_ERRORS: CommandError[] = authErrors();

/** Errors that apply to every authenticated command with permission gating. */
function permErrors(page: string): CommandError[] {
  return authErrors(apiErr(403, "Permission denied", `check ${page}`));
}

// ─── attachment shared fragments ─────────────────────────────────────────────
const ATTACHMENT_ENTITY_FLAGS: CommandFlag[] = [
  { name: "keikka", type: "number", description: "Target keikkaId" },
  { name: "vehicle", type: "number", description: "Target vehicleId" },
  { name: "person", type: "number", description: "Target personId" },
  { name: "customer", type: "number", description: "Target asiakasId" },
  { name: "worksite", type: "number", description: "Target tyomaaId" },
  { name: "sijainti", type: "number", description: "Target sijaintiId" },
  { name: "tuote", type: "number", description: "Target tuoteId" },
  { name: "bug-report", type: "number", description: "Target bugReportId" },
  { name: "request", type: "number", description: "Jerry pumppuRequestId (request owner only)" },
  { name: "offer", type: "number", description: "Jerry pumppuOfferId (provider company only)" },
  { name: "message", type: "number", description: "Target messageId (chat message; attach = message author, read = thread participant)" },
];
const ATTACHMENT_ROW =
  "{ attachmentId, origFileName, fileName, fileType, fileSize, fileComment, attachTime, liitaLaskuun, attachmentGroupId, attachmentGroupName, attachmentTypeId, attachmentTypeName, keikkaId?, vehicleId?, personId?, asiakasId?, tyomaaId?, sijaintiId?, tuoteId?, bugReportId?, pumppuRequestId?, pumppuOfferId?, messageId?, entryByPersonId, ownerAsiakasId, imageWidth, imageHeight }";
const ENTITY_FLAG_NOTE =
  "Exactly ONE entity flag selects the target (--keikka | --vehicle | --person | --customer | --worksite | --sijainti | --tuote | --bug-report | --request | --offer | --message).";
const DEPLOY_NOTE = "Deploy-gated (404 until the backend ships /api/cli/attachment/*).";

/** Appended to capped-list outputShapes — single-sources the wording + backend date. */
const TRUNCATED_NOTE =
  " (+truncated:true when the result hit the limit; backend ≥ 2026-06-11)";

/** Appended to server-capped log outputShapes: the /api/changes routes return no
 *  cursor, so a FULL page is the only "there may be more" signal — the CLI flags
 *  it client-side, so it works against any backend (fb#375). */
const LOG_CAPPED_NOTE =
  " (+truncated:true when the page filled --limit — cursor-less route, so a full page may hide older rows)";
/** Companion for log specs that also filter --field client-side (fb#375). */
const LOG_FIELD_HINT_NOTE =
  " (+hint when --field filtered a capped page: the filter saw only the newest --limit rows)";

// ─── legal shared fragments ──────────────────────────────────────────────────
const LEGAL_DEV_ERRORS: CommandError[] = [
  apiErr(401, "Token expired", "ib auth refresh"),
  apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
  apiErr(500, "Backend error", "retry with --verbose"),
];

// ─── vehicle cross-tenant (--asiakas) shared fragments ───────────────────────
// The --asiakas override on vehicle list/get/search reads another company's
// fleet; the extra permission line and 403 row are identical across all three
// specs, so single-source them here (see cliListKeyGen scopeParam + the
// hasVehicleAccessOnAsiakas gate in puminet5api).
const VEHICLE_ASIAKAS_PERMISSION =
  "--asiakas: sysadmin/developer or a vehicle-manage role (admin/owner/vehicleHandler) on the target tenant";
const VEHICLE_ASIAKAS_403: CommandError = apiErr(
  403,
  "No vehicle access on the requested --asiakas company",
  "use a tenant you have a vehicle-manage role on, or a developer token"
);
/** Shared by every vehicle-row list (list/search/driver board/driver gaps) — they
 *  all read `dbo.vehicle`, so they all surface the legacy sentinel rows that no
 *  id-taking command will accept (fb#380). One constant so the four can't drift. */
const VEHICLE_PLACEHOLDER_NOTE =
  "`placeholder: true` marks a legacy sentinel row (e.g. vehicleId 0 'Ei tietoa') that is listed but NOT addressable — `ib vehicle get 0` / `ib vehicle driver assign 0 …` exit 4. The key is absent on real vehicles. Which tenants carry one varies.";

/** Fleet ORDER is `sortNo`, which the rows carry but are not sorted by (fb#394):
 *  the list comes back in vehicleNo order, so a caller reproducing the grid's
 *  row order has to sort client-side — silently assuming the wire order IS the
 *  grid order is the failure this note exists to prevent. */
const VEHICLE_ORDERING_NOTE =
  "Rows come back ordered by `vehicleNo` (then vehicleId), NOT by `sortNo` — the grid orders on `sortNo`, so sort client-side to reproduce its row order.";
/** `asiakasId` vs `ownerAsiakasId`: distinct columns, and only the first varies
 *  within one response (fb#394). */
const VEHICLE_OWNER_NOTE =
  "`asiakasId` and `ownerAsiakasId` are distinct columns and often equal. `ownerAsiakasId` is the tenant this read is scoped to, so it is the SAME on every row of one response (the active company, or `--asiakas`); `asiakasId` is the assigned company and is what the grid splits own-vs-foreign vehicles on.";
// ─── person 404: say which DIMENSION failed (fb#620) ─────────────────────────
// `verify personId` is the wrong instruction most of the time this fires: the
// id is usually right and the SCOPE is wrong, because every person command is
// scoped to the active company. An agent that believes "this person does not
// exist" goes on to CREATE one — a duplicate row in a tenant that already had
// it. Naming both dimensions costs one line and removes that failure.
const PERSON_SCOPE_404_REMEDY =
  "the id may be fine and the SCOPE wrong — these commands read the ACTIVE company only. Either the personId does not exist, or it belongs to another tenant: retry with `--asiakas <id>` (on `person get`), find them with `ib customer person list --asiakas <id>` or `ib person search --my-companies`, or switch lens with `ib company switch <id>`. Do NOT conclude the person does not exist and create a new one — that mints a duplicate.";
const PERSON_SCOPE_NOTE =
  "Person reads are TENANT-SCOPED to your active company (plus global persons, ownerAsiakasId=null, and always yourself). A 404 therefore means 'not in this scope', not 'not in the database'.";

/** The list row is ~14 columns wide, so leftmost-fits would hide sortNo/ownership. */
const VEHICLE_LIST_PRETTY_COLUMNS = [
  "vehicleId",
  "vehicleNo",
  "plate",
  "name",
  "typeName",
  "sortNo",
  "showInGrid",
  "asiakasId",
] as const;

/* The `ib vehicle driver` day-keyed leaves take their date EITHER positionally
 * or as `--date` (fb#393). The group used to be positional-only while its
 * `vehicle timeline`/`route`/`visits` siblings were flag-shaped, so an agent
 * arriving from one of those spent an exit 4 on argument shape alone. Three
 * constants, so the six leaves state the same contract. */
const DRIVER_DATE_ARG: CommandArg = {
  name: "date",
  type: "date",
  required: false,
  description: "Day YYYY-MM-DD (or today/yesterday/tomorrow) — or pass it as --date",
};
const DRIVER_DATE_FLAG: CommandFlag = {
  name: "date",
  type: "date",
  description: "Day YYYY-MM-DD (or today/yesterday/tomorrow) — alias for the <date> positional",
};
const DRIVER_DATE_NOTE =
  "Give the day positionally OR as `--date` (the same flag `ib vehicle timeline` / `route` / `visits` take) — exactly one. Both together is fine only when they mean the same day; neither exits 4.";

// ─── cross-domain shared fragments ───────────────────────────────────────────
/** The system-admin 403 every `jerry admin` / admin-gated row repeats. */
const SYSADMIN_403: CommandError = apiErr(403, "Not a system admin", "use a system-admin token");
/**
 * `resolveRoleTypeId` rejects an unknown --role LOCALLY, before any request, so
 * every role-taking command needs this client row alongside its backend-400 twin
 * (the 400 is still reachable — the backend enforces role limits too).
 */
const ROLE_NAME_CLIENT_ERROR: CommandError = {
  origin: "client",
  exit: 4,
  meaning: "unknown or ambiguous role name — rejected by the CLI before any request",
  remedy:
    "pass an exact role name; the error names your options and `ib person role explain <name>` describes one. \"tarjousAdmin\" is not a role name — it denotes TWO (fb#418)",
};
/** The dual-target `--asiakas` alias flag (see targets.ts addAsiakasTargetOption). */
const ASIAKAS_TARGET_FLAG: CommandFlag = {
  name: "asiakas",
  type: "number",
  description: "Target asiakasId (alias for the positional)",
};

const BASE_COMMAND_SPECS: CommandSpec[] = [
  // ─── attachment (12) ─────────────────────────────────────────────────────
  {
    command: "ib attachment list",
    description: "List attachments linked to ONE entity, with group/type names on every row. Rows for companies the caller is not a member of are filtered out (keikka lists use the keikka-party check instead).",
    auth: "any",
    flags: [
      ...ATTACHMENT_ENTITY_FLAGS,
      { name: "group", type: "string", description: "Filter by group (NAME or id — `ib attachment types`)" },
      { name: "type", type: "string", description: "Filter by type (NAME or id — `ib attachment types`)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
    ],
    outputShape: `ListEnvelope<${ATTACHMENT_ROW}>`,
    errors: [apiErr(403, "Not a member of the target entity's company", "check the active company (ib auth whoami)"), ...COMMON_AUTH_ERRORS],
    notes: [ENTITY_FLAG_NOTE, "No SAS URLs in list rows — use `ib attachment get` for a download URL.", DEPLOY_NOTE],
    seeAlso: ["ib attachment get", "ib attachment types", "ib attachment search"],
    examples: ["ib attachment list --keikka 9001", "ib attachment list --vehicle 53 --group kuva", "ib attachment list --request 1234"],
  },
  {
    command: "ib attachment get",
    description: "One attachment: full metadata, group/type names, and a 1-hour read-SAS blobUrl for downloading the bytes directly from Azure.",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [],
    outputShape: `${ATTACHMENT_ROW} & { fileFolder, blobUrl }`,
    errors: [apiErr(404, "Attachment not found (or deleted)", "verify attachmentId"), apiErr(403, "No membership in the owner company or any keikka party", "check the active company"), ...COMMON_AUTH_ERRORS],
    notes: ["blobUrl expires in 1h — fetch it promptly; re-run get for a fresh one.", "Remote contexts (exec/MCP): fetch blobUrl yourself — `download` is denied there.", DEPLOY_NOTE],
    seeAlso: ["ib attachment download", "ib attachment list"],
    examples: ["ib attachment get 4711"],
  },
  {
    command: "ib attachment download",
    description: "Download the file to LOCAL disk (get + fetch blobUrl + write). Defaults to the original file name in the current directory; refuses to overwrite without --force. LOCAL ONLY — denied on /api/cli/exec and MCP because it would write the SERVER's filesystem.",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [
      { name: "out", type: "string", description: "Output path (default: origFileName in cwd)" },
      { name: "force", type: "boolean", description: "Overwrite an existing file" },
    ],
    outputShape: "{ ok: true, attachmentId, file (absolute path), bytes, fileType }",
    errors: [apiErr(404, "Attachment not found", "verify attachmentId"), { origin: "client", exit: 4, meaning: "Output file exists", remedy: "pass --force or --out <other path>" }, ...COMMON_AUTH_ERRORS],
    notes: ["Remote callers: use `ib attachment get` and fetch blobUrl yourselves.", DEPLOY_NOTE],
    seeAlso: ["ib attachment get"],
    examples: ["ib attachment download 4711", "ib attachment download 4711 --out C:\\temp\\site.jpg --force"],
  },
  {
    command: "ib attachment upload",
    description: "Upload a LOCAL file and link it to ONE entity in one step (mint SAS → PUT bytes to Azure → register metadata). --dry-run is CLIENT-side: validates the file and prints the would-be payload with ZERO network calls. LOCAL ONLY — denied on /api/cli/exec and MCP because it would read the SERVER's filesystem.",
    auth: "any",
    args: [{ name: "file", type: "string", description: "Path to the local file" }],
    flags: [
      ...ATTACHMENT_ENTITY_FLAGS,
      { name: "comment", type: "string", description: "fileComment shown in the UI" },
      { name: "group", type: "string", description: "Group (NAME or id — `ib attachment types`; default 1)" },
      { name: "type", type: "string", description: "Type (NAME or id — `ib attachment types`; default 1)" },
      { name: "mime", type: "string", description: "Override auto-detected MIME (fallback application/octet-stream)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ ok: true, attachmentId } | { dryRun: true, wouldUpload: {...} }",
    errors: [{ origin: "client", exit: 4, meaning: "File unreadable / bad entity flags", remedy: "check the path and pass exactly one entity flag" }, { origin: "client", exit: 6, meaning: "Azure PUT failed", remedy: "re-run; SAS expires in 1h" }, apiErr(403, "Not a member of the target entity's company", "check active company"), ...COMMON_AUTH_ERRORS],
    notes: [ENTITY_FLAG_NOTE, "No image compression — the file uploads as-is (the web UI compresses to ~1MB).", "Remote contexts: use upload-url + PUT yourself + register.", DEPLOY_NOTE],
    seeAlso: ["ib attachment upload-url", "ib attachment register", "ib attachment types"],
    examples: [
      "ib attachment upload ./site.jpg --keikka 9001 --comment \"pohjakuva\"",
      "ib attachment upload ./tarjous.pdf --offer 567 --reason \"offer docs\"",
      "ib attachment upload ./x.pdf --vehicle 53 --dry-run",
      "ib attachment upload ./kuva.jpg --message 9 --comment \"liite viestiin\"",
    ],
  },
  {
    command: "ib attachment upload-url",
    description: "Mint a 1-hour write-SAS upload URL (remote-safe primitive). The SERVER picks the blob path ({ownerAsiakasId}/{year}/{uuid}.{ext}) — callers cannot choose it. PUT your bytes to uploadUrl with header x-ms-blob-type: BlockBlob, then call `ib attachment register`.",
    auth: "any",
    flags: [{ name: "name", type: "string", required: true, description: "Original file name WITH extension" }],
    outputShape: "{ uploadUrl, fileFolder, fileName, putHeaders: { 'x-ms-blob-type': 'BlockBlob' }, expiresInSeconds: 3600 }",
    errors: [apiErr(400, "Missing/invalid name (needs an extension, no path separators)", "pass --name file.ext"), ...COMMON_AUTH_ERRORS],
    notes: ["Minting alone creates no DB row — unregistered blobs are orphans.", DEPLOY_NOTE],
    seeAlso: ["ib attachment register", "ib attachment upload"],
    examples: ["ib attachment upload-url --name site.jpg"],
  },
  {
    command: "ib attachment register",
    description: "Persist attachment metadata AFTER the bytes are in Azure (remote-safe primitive; step 3 of the upload flow). Server stamps identity from the JWT (entryByPersonId, ownerAsiakasId) and rejects fileFolder values outside the active company.",
    auth: "any",
    flags: [
      ...ATTACHMENT_ENTITY_FLAGS,
      { name: "name", type: "string", required: true, description: "fileName returned by upload-url" },
      { name: "orig-name", type: "string", required: true, description: "Original file name" },
      { name: "folder", type: "string", required: true, description: "fileFolder returned by upload-url" },
      { name: "size", type: "number", required: true, description: "File size in bytes" },
      { name: "mime", type: "string", required: true, description: "MIME type (stored as fileType)" },
      { name: "comment", type: "string", description: "fileComment" },
      { name: "group", type: "string", description: "Group (NAME or id; default 1)" },
      { name: "type", type: "string", description: "Type (NAME or id; default 1)" },
      { name: "etag", type: "string", description: "Azure ETag (optional)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, attachmentId } | { dryRun: true, wouldCreate: {...} }",
    errors: [apiErr(403, "fileFolder outside the active company / not a member of the target", "mint via upload-url; check active company"), apiErr(400, "Missing required field / unknown entity", "see required flags"), ...COMMON_AUTH_ERRORS],
    notes: [ENTITY_FLAG_NOTE, "Audited via ChangeTracker on the linked entity's timeline (--reason lands in changeTracker.reason).", DEPLOY_NOTE],
    seeAlso: ["ib attachment upload-url", "ib attachment upload"],
    examples: ["ib attachment register --name uuid.jpg --orig-name site.jpg --folder 8/2026 --size 12345 --mime image/jpeg --keikka 9001"],
  },
  {
    command: "ib attachment attach",
    description: "Link an EXISTING attachment to one entity (sets that FK; an attachment may be linked to several entities at once — other links are untouched).",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [...ATTACHMENT_ENTITY_FLAGS],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, attachmentId, <column>: entityId } | { dryRun: true, wouldAttach: {...} }",
    errors: [apiErr(404, "Attachment not found", "verify attachmentId"), apiErr(403, "No membership on attachment or target", "check active company"), ...COMMON_AUTH_ERRORS],
    notes: [ENTITY_FLAG_NOTE, "Audited via ChangeTracker on the target entity's timeline.", DEPLOY_NOTE],
    seeAlso: ["ib attachment detach", "ib attachment list"],
    examples: ["ib attachment attach 4711 --vehicle 53", "ib attachment attach 4711 --keikka 9002 --dry-run"],
  },
  {
    command: "ib attachment detach",
    description: "Unlink an attachment from ONE entity (NULLs that FK). Requires a manager role (Admin / KeikkaHandler / AttachmentHandler / Owner) on the attachment's OWNER company — same gate as the web UI. A fully unlinked attachment appears in `ib attachment search --missing`.",
    auth: "any",
    args: [
      { name: "attachmentId", type: "number", description: "attachments.attachmentId" },
      { name: "entity", type: "string", required: false, description: "keikka|vehicle|person|customer|worksite|sijainti|tuote|bug-report|request|offer (omit when using a --<entity> flag instead)" },
    ],
    flags: [...ATTACHMENT_ENTITY_FLAGS],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, attachmentId, detached: entity } | { dryRun: true, wouldDetach: {...} }",
    errors: [apiErr(403, "Not owner company or missing manager role", "switch to the owner company; need Admin/KeikkaHandler/AttachmentHandler/Owner"), apiErr(404, "Attachment not found", "verify attachmentId"), { origin: "client", exit: 4, meaning: "No entity given, or conflicting positional + flag", remedy: "name the entity once — positional word OR a --<entity> flag" }, ...COMMON_AUTH_ERRORS],
    notes: ["Name the entity as a positional word (`detach 4711 keikka`) OR an attach-style flag (`detach 4711 --keikka 9001`) — the flag's id is ignored since detach only needs the entity name.", "Audited via ChangeTracker on the previously-linked entity's timeline.", DEPLOY_NOTE],
    seeAlso: ["ib attachment attach", "ib attachment search"],
    examples: ["ib attachment detach 4711 keikka", "ib attachment detach 4711 --keikka 9001", "ib attachment detach 4711 bug-report --dry-run"],
  },
  {
    command: "ib attachment update",
    description: "Update comment / group / type / invoice-flag. The server read-merges: fields you do not pass keep their current values (entity links are never touched by update). liitaLaskuun additionally requires lasku or asiakas admin.",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [
      { name: "comment", type: "string", description: "New fileComment" },
      { name: "liita-laskuun", type: "number", description: "0|1 invoice-attachment flag (lasku/asiakas admin only)" },
      { name: "group", type: "string", description: "Group (NAME or id — `ib attachment types`)" },
      { name: "type", type: "string", description: "Type (NAME or id — `ib attachment types`)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, attachmentId } | { dryRun: true, wouldUpdate: { fileComment: {from,to}, liitaLaskuun: {from,to}, ... } }",
    errors: [apiErr(403, "Not owner company / missing manager role / liitaLaskuun without lasku-admin", "use an account with lasku or asiakas admin role on the owner company"), apiErr(404, "Attachment not found", "verify attachmentId"), ...COMMON_AUTH_ERRORS],
    notes: ["Comment changes are audited via ChangeTracker.", DEPLOY_NOTE],
    seeAlso: ["ib attachment types", "ib attachment get"],
    examples: ["ib attachment update 4711 --comment \"hyväksytty\"", "ib attachment update 4711 --group laskutus --liita-laskuun 1"],
  },
  {
    command: "ib attachment delete",
    description: "Soft-delete the DB row AND hard-delete the Azure blob — the blob deletion is IRREVERSIBLE. --reason is hard-required (client exits 4 without it; server 400s without the header). Requires a manager role on the owner company.",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    reasonDetail: "(blob deletion is irreversible)",
    mutates: true,
    outputShape: "{ ok: true, attachmentId, deleted: true, blobDeleted } | { dryRun: true, wouldDelete: { attachmentId, blobName, origFileName } }",
    errors: [{ origin: "client", exit: 4, meaning: "Missing --reason", remedy: "pass --reason 'why'" }, apiErr(400, "Missing X-Action-Reason header", "pass --reason"), apiErr(403, "Not owner company or missing manager role", "switch to the owner company"), apiErr(404, "Attachment not found or already deleted", "verify attachmentId"), ...COMMON_AUTH_ERRORS],
    notes: ["ALWAYS preview with --dry-run first.", "Audited via ChangeTracker with your --reason.", DEPLOY_NOTE],
    seeAlso: ["ib attachment get", "ib attachment detach"],
    examples: ["ib attachment delete 4711 --dry-run --reason preview", "ib attachment delete 4711 --reason \"duplicate upload\""],
  },
  {
    command: "ib attachment types",
    description: "Attachment groups + types legend (id + name + description), tenant-scoped reference data. Use these NAMES or ids in --group/--type flags everywhere in this group.",
    auth: "any",
    flags: [],
    outputShape: "{ groups: [{ attachmentGroupId, attachmentGroupName, attachmentGroupDescription, active }], types: [{ attachmentTypeId, attachmentGroupId, attachmentTypeName, attachmentTypeDescription, active }] }",
    errors: COMMON_AUTH_ERRORS,
    notes: ["Cached server-side (~hours); names are the single source of truth (code constants drift).", DEPLOY_NOTE],
    seeAlso: ["ib attachment list", "ib attachment upload"],
    examples: ["ib attachment types", "ib attachment types --pretty"],
  },
  {
    command: "ib attachment search",
    description: "Search attachments in the ACTIVE company by file name / comment, list orphans (no linked entity) with --missing, or — given no text and no --missing — list ALL active company attachments (parity with `ib keikka list`).",
    auth: "any",
    args: [{ name: "text", type: "string", required: false, description: "Search text; omit to list all (or combine with --missing)" }],
    flags: [
      { name: "missing", type: "boolean", description: "Only attachments with NO linked entity" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
    ],
    outputShape: `ListEnvelope<${ATTACHMENT_ROW}>`,
    errors: [...COMMON_AUTH_ERRORS],
    notes: ["Tenant comes from the JWT — there is no company parameter.", "No text and no --missing lists every active attachment in the company (capped at --limit; `truncated:true` signals more).", DEPLOY_NOTE],
    seeAlso: ["ib attachment list", "ib attachment detach"],
    examples: ["ib attachment search", "ib attachment search kuormakirja", "ib attachment search --missing"],
  },
  // ─── auth (6) ────────────────────────────────────────────────────────────
  {
    command: "ib auth login",
    description:
      "Open the system browser to authorize this CLI via OAuth 2.1 + PKCE and persist credentials to ~/.ibetoni/credentials.json (mode 0600).",
    auth: "none",
    flags: [
      {
        name: "endpoint",
        type: "url",
        default: "https://api.ibetoni.fi",
        description: "API endpoint to authorize against",
      },
    ],
    outputShape:
      "stderr: the authorization URL + 'Waiting for the OAuth callback…' immediately, then 'Logged in as <email> at <company>.'; credentials file written",
    errors: [
      {
        origin: "client",
        exit: 2,
        match: ["oauth callback", "token exchange failed", "login token is missing", "failed to bind callback server"],
        meaning: "OAuth flow failed",
        remedy: "retry; check network / browser",
      },
      {
        origin: "client",
        exit: 2,
        match: ["authorize preflight failed", "cannot reach"],
        meaning: "Authorize preflight failed (4xx/5xx from /oauth/authorize, or endpoint unreachable)",
        remedy:
          "the server's error is surfaced immediately without opening the browser (no 5-min callback hang) — fix the server-side cause (e.g. OAuth client registration / Redis) or the endpoint/network, then retry",
      },
      apiErr(500, "Backend error", "retry later"),
    ],
    notes: [
      "HEADLESS/no-browser environments (CI, sandboxes): the OAuth callback must land on the machine running the CLI, so this command cannot complete there — set IB_TOKEN=<jwt> (a betoni.online JWT) in the env instead; every command picks it up (non-refreshable; a 401 surfaces immediately). The authorization URL and a waiting message are printed to stderr so a stuck flow is visible.",
      "Fail-fast preflight: before opening the browser the CLI GETs the /oauth/authorize URL (10s timeout, side-effect-free server-side); a 4xx/5xx or unreachable endpoint fails immediately with the server's error instead of the silent 5-minute callback-timeout hang. A preflight TIMEOUT fails open (browser flow proceeds) so a slow cold-start never blocks a login that would have worked.",
    ],
    examples: [
      "ib auth login",
      "ib auth login --endpoint https://api-staging.ibetoni.fi",
    ],
  },
  {
    command: "ib auth logout",
    description:
      "Revoke the refresh token server-side (best-effort) and delete the local credentials file.",
    auth: "any",
    flags: [],
    outputShape: "no stdout output; exit 0 on success",
    errors: [
      { origin: "client", exit: 1, meaning: "I/O error", remedy: "check file permissions" },
    ],
    examples: ["ib auth logout"],
  },
  {
    command: "ib auth whoami",
    description:
      "One-shot orientation for the active session: who/where you are, what you can do (tier), and where else you can act (companies). Decoded from the JWT, so it works for IB_TOKEN sessions too (not just the on-disk creds store). An EXPIRED file session self-heals (refresh, incl. the OAuth refresh-token grant) or exits 2 — a dead session is caught here, not on your next write. Run it first.",
    auth: "any",
    flags: [],
    outputShape:
      "{ personId, email?, activeCompany: { asiakasId, name, betoniJerryUmbrella? }, tier: 'developer'|'admin'|'standard', companies: { asiakasId, roles }[], endpoint, source: 'file'|'env', readOnly, tokenExpiresAt?, tokenExpired?, refreshed?, impersonating? } — `tier` is the discovery/capability gate; `companies` are the `company switch` targets (no name in the JWT — use `ib company list` for names); `source:'env'` = IB_TOKEN (non-refreshable); `refreshed: true` = the stored JWT had expired and whoami self-healed the session before reporting.",
    errors: [
      { origin: "client", exit: 2, match: "not logged in", meaning: "Not logged in", remedy: "ib auth login first (or set IB_TOKEN)" },
      {
        origin: "client",
        exit: 2,
        // "and unrefreshable" — NOT "session expired", which is also a substring
        // of the impersonation row's message below.
        match: "and unrefreshable",
        meaning: "Session expired and unrefreshable (both the JWT-bearer refresh and the OAuth refresh-token grant failed)",
        remedy: "ib auth login to re-authenticate",
      },
      {
        origin: "client",
        exit: 2,
        match: "ib_token is expired",
        meaning: "IB_TOKEN expired (env sessions have no refresh path)",
        remedy: "mint a fresh JWT and update IB_TOKEN",
      },
      {
        origin: "client",
        exit: 2,
        match: "ib_token is not a jwt",
        meaning:
          "IB_TOKEN is not JWT-shaped (not 3 dot-separated segments) — a value problem, not a rejected credential",
        remedy:
          "a command substitution (IB_TOKEN=$(…)) captures the whole stdout, banners included — re-set IB_TOKEN to the bare token",
      },
      {
        origin: "client",
        exit: 2,
        match: "impersonation session expired",
        meaning: "Impersonation session expired (never auto-refreshed — it would escalate)",
        remedy: "ib auth impersonate --end to restore your own login, or re-impersonate",
      },
    ],
    notes: [
      "Exit 0 means the session is USABLE: a non-expired token, or an expired file session that was just self-healed (`refreshed: true`; the rotated tokens are persisted). Exit 2 means re-auth is required — so `ib auth whoami && <write>` is a sound guard (fb#258).",
      "Self-heal persists a rotated JWT/refresh token to the creds file even under --read-only — same stance as the client's transparent refresh-on-401 (local session maintenance, not a domain write).",
    ],
    examples: ["ib auth whoami"],
  },
  {
    command: "ib auth switch",
    description:
      "Switch the active company. Issues a new JWT bound to the target ownerAsiakasId and persists it.",
    auth: "any",
    // No tenant-data write, but persists local auth state (rotated JWT) and is
    // blocked under read-only — classify as a write so isWrite agrees with the gate.
    mutates: true,
    flags: [
      {
        name: "to",
        type: "number",
        description: "Target asiakasId to switch to",
      },
    ],
    outputShape: "{ ok: true, activeCompany: { asiakasId, name } }",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login" },
      apiErr(403, "No access to target", "verify ownership via `ib company list`"),
      {
        origin: "client",
        exit: 3,
        meaning: "Read-only mode active (--read-only / IB_READ_ONLY)",
        remedy:
          "persisted switch is blocked under read-only; use the per-command global --company <id> ephemeral context",
      },
    ],
    notes: [
      "Persists a rotated JWT bound to the target company — blocked under read-only mode (exit 3).",
      "For a one-command company context that does NOT persist, use the global `--company <id>` flag instead.",
    ],
    examples: ["ib auth switch --to 1349"],
  },
  {
    command: "ib auth refresh",
    description:
      "Manually refresh the JWT: JWT-bearer refresh (/api/auth/refresh-token) first, falling back to the OAuth refresh-token grant (/oauth/token) when the JWT has already expired — so a session idle past the 7-day JWT lifetime still recovers without a browser reflow (90-day refresh-token window). Automatic refresh-on-401 (same chain) also happens in the API client.",
    auth: "any",
    flags: [],
    outputShape: "{ ok: true }",
    errors: [
      {
        origin: "client",
        exit: 2,
        meaning: "Refresh failed on every path (JWT-bearer AND OAuth refresh-token grant)",
        remedy: "ib auth login to re-authenticate",
      },
      {
        origin: "client",
        exit: 4,
        meaning: "Refresh refused while impersonating (it would escalate to a permanent login as the target)",
        remedy: "ib auth impersonate --extend (10 more minutes) or --end (restore your own login)",
      },
    ],
    notes: [
      "The OAuth grant rotates the stored refresh token (single-use, reuse-detected) and persists the successor immediately. It re-mints the LOGIN-time company; if you had `auth switch`ed since, the CLI switches the fresh JWT back to your persisted active company automatically.",
    ],
    examples: ["ib auth refresh"],
  },
  {
    command: "ib auth impersonate",
    description:
      "Impersonate another person: mint a 10-minute impersonation JWT for the target and persist it as the active credential (your own login is stashed for restore). `--end` restores it; `--extend` renews 10 more minutes. Server-gated by canImpersonate (systemAdmin/roleManager, same-tenant admin over a non-admin target, or an explicit grant). Local CLI only — denied over the exec/MCP bridge.",
    auth: "any",
    mutates: true,
    tier: "admin",
    args: [
      { name: "personId", type: "number", required: false, description: "Target personId (or use --email). Omit with --end/--extend." },
    ],
    flags: [
      { name: "email", type: "string", description: "Target email (alternative to the personId positional)" },
      { name: "end", type: "boolean", description: "End the active impersonation session and restore your own login" },
      { name: "extend", type: "boolean", description: "Extend the active impersonation session by 10 minutes" },
    ],
    outputShape:
      "start: { ok:true, impersonating:{ personId, actorPersonId, expiresAt } }. --end: { ok:true, restored:{ personId } }. --extend: { ok:true, expiresAt }.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login" },
      apiErr(403, "Impersonation not allowed for the target", "needs systemAdmin/roleManager, same-tenant admin, or a grant"),
      apiErr(404, "Target not found (or has no personEmail)", "no impersonatable person for that personId/email. NB: a personId that EXISTS but has no personEmail also 404s here (impersonation is email-keyed) — verify with `ib person get <id>`; an email-less person cannot be impersonated."),
      { origin: "client", exit: 3, meaning: "Read-only mode active (--read-only / IB_READ_ONLY)", remedy: "impersonation persists a rotated JWT; drop read-only" },
      { origin: "client", exit: 4, meaning: "No active session (--end/--extend), or neither personId nor --email given", remedy: "start with `ib auth impersonate <personId>`" },
    ],
    notes: [
      "Persists a 10-minute impersonation JWT as the active credential — blocked under read-only (exit 3).",
      "Auto-refresh-on-401 is disabled while impersonating (it would escalate to a 7-day login); a 401 surfaces — re-run impersonate or `--extend`.",
      "`ib auth whoami` shows an `impersonating` block while a session is active.",
      "Target resolution is email-keyed (getPersonDataFromEmail): a person with no personEmail cannot be impersonated and 404s identically to a missing person (feedback #113) — verify a suspect personId with `ib person get <id>`.",
      "Local CLI only — the `auth` group is denied over /api/cli/exec and MCP ib_exec.",
    ],
    examples: [
      "ib auth impersonate 6233",
      "ib auth impersonate --email someone@example.com",
      "ib auth impersonate --extend",
      "ib auth impersonate --end",
    ],
  },

  // ─── fennoa (system admin) ───────────────────────────────────────────────
  {
    command: "ib fennoa purchases",
    description:
      "Open purchase invoices (payables) fetched live from Fennoa — default target PumiNet Oy (asiakasId 26). System-admin only; result cached 15 min server-side.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "all", type: "boolean", description: "Include settled invoices in the window, not only open (total_due > 0)" },
      { name: "months", type: "number", default: "6", description: "Created-after window in months (default 6, max 12)" },
      { name: "asiakas", type: "number", description: "Target company override (e.g. 8 = Kalle Urho Oy verification path)" },
      { name: "refresh", type: "boolean", description: "Bypass the server's 15-minute cache" },
    ],
    outputShape:
      "ListEnvelope<{ id, supplierName, invoiceNumber, dueDate, totalDue, totalGross, paymentStatus, approvalStatus, ... }> & { summary: { count, totalDue, overdueCount, overdueTotal, oldestDueDate }, fetchedAt, asiakasId, months, cached? }",
    errors: [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a system admin", "requires isSystemAdmin"),
      apiErr(424, "Fennoa credentials missing for the target company", "add apiKeys rows (ownerAsiakasId + apiKeySourceId 16, USER/KEY) or use --asiakas 8"),
      apiErr(500, "Backend or Fennoa API error", "retry with --verbose"),
    ],
    notes: ["Live two-phase Fennoa fetch (list + per-invoice detail); 'open' = total_due > 0 — the Fennoa API has no unpaid filter."],
    examples: ["ib fennoa purchases", "ib fennoa purchases --asiakas 8 --months 2", "ib fennoa purchases --all --refresh"],
  },

  // ─── company (6) ─────────────────────────────────────────────────────────
  {
    command: "ib company list",
    description:
      "List the companies the current user can act on — name, the roles held there, and the active one marked `current: true`. The one-call answer to 'where can I act, as what'.",
    auth: "any",
    flags: [],
    outputShape:
      "ListEnvelope<{ asiakasId, name, current, roles }> = { items, nextCursor, count }",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      // whoami holds the roles but no names (the JWT carries a name only for the
      // ACTIVE company), so the names could not go the other way without making
      // the pure, no-I/O whoami do a network call — the roles came here instead
      // (fb#380).
      "`roles` are read from your own JWT, so they cost no extra round-trip. `[]` = membership with no roles (a real state), not an error.",
      "`ib auth whoami` reports the same memberships but names only the ACTIVE company — use this command when you need the names.",
    ],
    seeAlso: ["ib auth whoami", "ib company switch"],
    examples: ["ib company list", "ib company list --pretty"],
  },
  {
    command: "ib company current",
    description:
      "Return the record of the active company (the one bound to the current JWT).",
    auth: "any",
    flags: [],
    outputShape: "{ asiakasId, name }",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "The asiakasId to pass to `ib customer modules` / `ib customer settings` when the tenant you want to configure is your OWN company.",
    ],
    seeAlso: ["ib customer modules", "ib customer settings"],
    examples: ["ib company current"],
  },
  {
    command: "ib company switch",
    description:
      "Switch the active company. Alias of `ib auth switch`. Persists the rotated JWT.",
    auth: "any",
    // Same classification as `ib auth switch`: local-state write, gated under read-only.
    mutates: true,
    flags: [
      {
        name: "to",
        type: "number",
        description: "Target asiakasId to switch to",
      },
    ],
    outputShape: "{ ok: true, activeCompany: { asiakasId, name } }",
    errors: [
      apiErr(403, "No access to target", "verify via `ib company list`"),
      {
        origin: "client",
        exit: 3,
        meaning: "Read-only mode active (--read-only / IB_READ_ONLY)",
        remedy:
          "persisted switch is blocked under read-only; use the per-command global --company <id> ephemeral context",
      },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Persists a rotated JWT bound to the target company — blocked under read-only mode (exit 3).",
      "For a one-command company context that does NOT persist, use the global `--company <id>` flag instead.",
    ],
    examples: ["ib company switch --to 1349"],
  },
  {
    command: "ib validate",
    description:
      "Validate a company OR a single employee against a profile — a pass/fail/skip checklist with Finnish details naming what is missing. Entity is inferred from --person: absent → company (profiles: jerry, betoni; --profile required); present → person (profile: onboarding, default). `ib validate list` lists profiles. Company: GET /api/validation/:profile/:asiakasId. Person: GET /api/validation/person/:profile/:asiakasId/:personId.",
    permissions: [
      "company: system admin OR admin-tier role in the target (or owner) company",
      "person: the above OR HR admin (typeId 24) of the target company",
    ],
    args: [
      { name: "action", type: "string", required: false, description: "Use 'list' to list available profiles; omit to run validation." },
    ],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (default: active company)" },
      { name: "person", type: "number", description: "Validate this person as an employee (switches to person validation)" },
      { name: "profile", type: "string", description: "Profile id (company: jerry|betoni, required; person: onboarding, default)" },
      { name: "keikka", type: "number", description: "Validate this keikka against the reminders-drawer rules (alias of `ib keikka validate <id>`)" },
    ],
    outputShape:
      "list: ListEnvelope<{ id, titleFi, description, entity:'company'|'person' }>. company: { entity:'company', profile, asiakasId, asiakasNimi, ok, summary, checks[] }. person: { entity:'person', profile, asiakasId, asiakasNimi, personId, personNimi, ok, summary, checks:[{ id, severity, status:'pass'|'fail'|'skip', titleFi, detail? }] }.",
    errors: [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not an admin/HR of the target company", "use an admin/HR token"),
      apiErr(404, "Unknown profile for that entity, or company/person not found", "run `ib validate list` to see profiles"),
      { origin: "client", exit: 4, meaning: "Missing --profile for company validation, or a non-positive --asiakas/--person", remedy: "pass --profile (jerry|betoni) for a company, or a positive --asiakas/--person; run `ib validate list`" },
    ],
    notes: [
      "ok = every applicable 'required' check passes; skipped checks (conditional, not applicable) and recommended/optional never flip it.",
      "status 'skip' = the check did not apply (e.g. Ajoneuvot-moduuli only checked for pumppari); excluded from summary counts.",
      "Exit code is 0 even when ok:false — the JSON carries the outcome.",
      "Deploy-gated: returns 404 until /api/validation is deployed.",
      "'ib company validate' was renamed to this command (exit 4 on the old path).",
    ],
    seeAlso: ["ib person get", "ib customer modules", "ib jerry admin detail"],
    examples: [
      "ib validate list",
      "ib validate --asiakas 8 --profile betoni",
      "ib validate --asiakas 8 --person 10",
      "ib validate --person 10 --profile onboarding",
      "ib validate --keikka 9001",
    ],
  },
  {
    command: "ib company validate",
    description:
      "Renamed to the top-level `ib validate` (clean break). This path now exits 4 with a hint. Use `ib validate --asiakas <id> --profile <p>` (company) or `ib validate --asiakas <id> --person <id>` (employee).",
    permissions: ["none (always errors)"],
    flags: [],
    outputShape: "(none — always an error envelope)",
    errors: [
      { origin: "client", exit: 4, meaning: "'ib company validate' was renamed to 'ib validate'", remedy: "use `ib validate --asiakas <id> --profile <p>` (company) or `ib validate --asiakas <id> --person <id>` (employee)" },
    ],
    notes: [
      "Clean-break rename (mirrors the ib changes→ib log rename). The command is hidden and only emits the rename hint.",
    ],
    seeAlso: ["ib validate list"],
    examples: ["ib validate list", "ib validate --asiakas 8 --profile betoni"],
  },
  // (The `ib company modules|settings` signpost specs were retired with their
  // commands — the sibling-group resolver in unknownCommand.ts answers now.)

  // ─── betoni (5) — concrete reference data, read-only (fb#426) ────────────
  {
    command: "ib betoni laatu list",
    description:
      "List the concrete grades one supplier can offer (GET /api/betoni/laatu/list/:betoniToimittajaAsiakasId): its OWN rows plus the shared (yhteinen) ones, in sortNum order. Each row carries a derived `shared` boolean so the two populations the response mixes can be told apart.",
    auth: "any",
    flags: [
      { name: "asiakas", type: "number", description: "Supplier (betoniToimittajaAsiakasId) whose catalogue to read; default = your active company" },
      { name: "search", type: "string", description: "Client-side substring filter over laatuNimike / laatuLyhenne / laatuSelite" },
      { name: "shared-only", type: "boolean", description: "Only the shared (asiakasId 0) grades" },
      { name: "own-only", type: "boolean", description: "Only the supplier's own grades (excludes the shared ones)" },
    ],
    outputShape:
      "ListEnvelope<{ laatuId, laatuNimike, laatuLyhenne, laatuLaji, laatuSelite, sortNum, asiakasId, shared, isEnabled, showInDropDown, laatuAllowedS, laatuAllowedRae, laatuAllowedC, laatuShortCuts, laatuHelpId }>",
    prettyColumns: ["laatuId", "laatuNimike", "laatuLyhenne", "asiakasId", "shared", "isEnabled", "sortNum"],
    errors: [
      { origin: "client", exit: 4, match: "mutually exclusive", meaning: "--shared-only and --own-only both given", remedy: "they name two disjoint sets — pass one, or neither for both" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --asiakas <supplierId>, or `ib auth switch`" },
      { http: 400, exit: 4, meaning: "Invalid betoniToimittajaAsiakasId", remedy: "--asiakas must be a non-negative integer" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
    ],
    notes: [
      "asiakasId 0 is the SHARED (yhteinen) grade pool visible to every tenant; anything else is that supplier's own. The backend returns both in one list with no marker — `shared` is derived client-side.",
      "Deliberately NOT restricted to your own tenant: a customer legitimately reads its SUPPLIER's catalogue, which is why the backend scopes the cache key by supplier rather than by caller.",
      "The rows come from betoniLaatuView. laatuAllowedRae/laatuAllowedS/laatuAllowedC are expressed in the vocabularies `ib betoni reference` returns.",
    ],
    seeAlso: ["ib betoni laatu get", "ib betoni reference"],
    examples: [
      "ib betoni laatu list",
      "ib betoni laatu list --asiakas 8 --shared-only",
      "ib betoni laatu list --search rapid --pretty",
    ],
  },
  {
    command: "ib betoni laatu get",
    description:
      "One concrete grade by laatuId. Resolved from the supplier's list rather than a get endpoint (the backend mounts no route for `betoniLaatu.get`), so visibility is identical to `laatu list` — you can only get a grade you could already list.",
    auth: "any",
    args: [{ name: "laatuId", type: "number", description: "laatuId (the PK of betoniLaatu)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Supplier whose catalogue to search; default = your active company" },
    ],
    outputShape: "{ laatuId, laatuNimike, laatuLyhenne, laatuLaji, laatuSelite, sortNum, asiakasId, shared, isEnabled, showInDropDown, ... }",
    errors: [
      { origin: "client", exit: 5, match: "not found in this supplier's catalogue", meaning: "no such grade in the resolved catalogue", remedy: "`ib betoni laatu list` to see it; a grade owned by ANOTHER supplier needs --asiakas <supplierId>" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --asiakas <supplierId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
    ],
    seeAlso: ["ib betoni laatu list"],
    examples: ["ib betoni laatu get 42", "ib betoni laatu get 42 --asiakas 8"],
  },
  {
    command: "ib betoni attr list",
    description:
      "List concrete additives (betoniAttr) for one supplier under one owning tenant (GET /api/betoni/attr/list/:betoniAsiakasId/:ownerAsiakasId). Both scope columns treat 0 as \"any\", and the backend matches each independently.",
    auth: "any",
    permissions: ["read access on the target ownerAsiakasId"],
    args: [{ name: "betoniAsiakasId", type: "number", description: "Supplier scope (0 = any supplier)" }],
    flags: [
      { name: "owner", type: "number", description: "Owning tenant (ownerAsiakasId); default = your active company" },
    ],
    outputShape:
      "ListEnvelope<{ attrId, attrNimike, attrSelite, attrYksikkö, hinta, betoniAsiakasId, ownerAsiakasId, shared, isEnabled, showInDropDown, attrShortCuts, attrHelpId, entryTime, lastModifiedTime }>",
    prettyColumns: ["attrId", "attrNimike", "attrYksikkö", "hinta", "betoniAsiakasId", "ownerAsiakasId", "shared", "isEnabled"],
    errors: [
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --owner <asiakasId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
      { http: 403, exit: 3, meaning: "No read access to the requested ownerAsiakasId", remedy: "you may only read a tenant you have access to — check `ib auth whoami`" },
    ],
    notes: [
      "`shared` is true only when BOTH betoniAsiakasId AND ownerAsiakasId are 0. A row global on one axis is still scoped on the other, so a single 0 does not mean \"everyone sees it\".",
      "`hinta` is decimal(10,2) NULL — null means NO PRICE SET, which is distinct from 0.",
    ],
    seeAlso: ["ib betoni attr get"],
    examples: ["ib betoni attr list 0", "ib betoni attr list 8 --owner 1349"],
  },
  {
    command: "ib betoni attr get",
    description:
      "One concrete additive by attrId, scoped to an owning tenant (GET /api/betoni/attr/get/:attrId/:ownerAsiakasId). The route returns a recordset even for one row; this unwraps it.",
    auth: "any",
    permissions: ["read access on the target ownerAsiakasId"],
    args: [{ name: "attrId", type: "number", description: "attrId (the PK of betoniAttr)" }],
    flags: [
      { name: "owner", type: "number", description: "Owning tenant (ownerAsiakasId); default = your active company" },
    ],
    outputShape: "{ attrId, attrNimike, attrSelite, attrYksikkö, hinta, betoniAsiakasId, ownerAsiakasId, shared, isEnabled, showInDropDown, ... }",
    errors: [
      { origin: "client", exit: 5, match: "Attribute not found", meaning: "no such attribute for that owner", remedy: "the id may belong to ANOTHER tenant — the backend does not distinguish that from 'no such row'. Cross-check with `ib betoni attr list <betoniAsiakasId> --owner <id>`" },
      { origin: "client", exit: 4, match: "could not resolve active company", meaning: "no usable ownerAsiakasId on the token", remedy: "pass --owner <asiakasId>, or `ib auth switch`" },
      { http: 401, exit: 2, meaning: "Token expired", remedy: "ib auth refresh" },
      { http: 403, exit: 3, meaning: "No read access to the requested ownerAsiakasId", remedy: "check `ib auth whoami`" },
    ],
    seeAlso: ["ib betoni attr list"],
    examples: ["ib betoni attr get 12", "ib betoni attr get 12 --owner 1349"],
  },
  {
    command: "ib betoni reference",
    description:
      "The four fixed concrete lookup lists — raekoko (aggregate size), lujuus (strength), notkeus (consistency), kayttoika (working life) — in ONE call. These are the vocabularies a grade's laatuAllowedRae / laatuAllowedS / laatuAllowedC fields are expressed in.",
    auth: "none",
    flags: [
      { name: "kind", type: "string", description: "Return only one list", allowed: ["raekoko", "lujuus", "notkeus", "kayttoika"] },
    ],
    outputShape: "{ raekoko: [...], lujuus: [...], notkeus: [...], kayttoika: [...] } — narrowed to the single key when --kind is given",
    errors: [
      { origin: "client", exit: 4, match: "--kind must be one of", meaning: "unknown --kind value", remedy: "one of: raekoko, lujuus, notkeus, kayttoika" },
      { http: 500, exit: 6, meaning: "Backend error", remedy: "retry with --verbose" },
    ],
    notes: [
      "Bundled rather than split into four leaves because they are read together: decoding one grade's allowed-values fields needs all four vocabularies at once.",
      "These four routes are unauthenticated reference data, cached server-side with a 2-hour TTL.",
    ],
    seeAlso: ["ib betoni laatu list"],
    examples: ["ib betoni reference", "ib betoni reference --kind raekoko"],
  },

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
    errors: permErrors("auth.page.grid.tilaus.read"),
    notes: [
      "`tila` is the numeric keikkaTilaId. Legend: -1 Uusi tilaus · 0 Luonnos (draft) · 1 Kesken · 2 Lähetetty (sent) · 3 Käsittelyssä · 4 Toimitusvalmis · 5 Toimitus meneillään · 6 Toimitus epäonnistui · 7 Epäonnistui · 8 Peruttu (cancelled) · 9/12/13 Toimitettu (delivered) · 10 Poistettu (deleted) · 100 Valmis (complete) · 11/200 Järjestelmätilaus (system, do not edit).",
      "The same legend is in the GLOSSARY (`tila`) on `ib --help`; source of truth: GET /api/tila/list.",
      "A keikka spanning multiple worksites returns ONE ROW PER tyomaa (join fan-out): the same keikkaId can appear on several rows with different tyomaaId, and `count` counts ROWS, not distinct deliveries — dedupe by keikkaId when counting deliveries.",
      "Default window is TODAY only (--from/--to both default to today). A count:0 with exit 0 is a permitted query that found no data in that window — NOT an access error (denial is exit 3 / HTTP 403); the envelope's `hint` says so. Widen with --from/--to, or use `ib keikka latest` to find the most recent keikka regardless of date.",
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
      { origin: "client", exit: 4, meaning: "--status not a numeric keikkaTilaId", remedy: "pass a number, e.g. --status 9" },
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


  // ─── customer (12) ───────────────────────────────────────────────────────
  {
    command: "ib customer list",
    description: "List customers (asiakkaat).",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows for the unbounded list (capped at 500). Ignored when --ids is given.",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
      { name: "full", type: "boolean", description: "Return full customer fields + companyDescription (not just id/name/ytunnus/type)" },
      { name: "ids", type: "string", description: "Comma-separated asiakasIds to return ALL of (max 1000) — preferred for targeted/incremental fetches" },
      { name: "include", type: "string", description: "Expand each row with per-customer arrays: contacts and/or sijainnit (CSV; best with --full)" },
      { name: "fields", type: "string", description: "Project each customer to just these columns (CSV; asiakasId always kept, contacts/sijainnit arrays preserved) — cuts the diff payload" },
      { name: "sijainti-types", type: "string", description: "With --include sijainnit: keep only these sijaintiTypeId rows (CSV, e.g. 1,2) — filtered server-side so a 45-location supplier's irrelevant rows are never fetched" },
      { name: "since", type: "string", description: "Only customers registered on/after this day (YYYY-MM-DD, or today/yesterday) — 'new customers since X'. Server-side filter on the registration timestamp." },
      { name: "sort", type: "string", description: "Result ordering: name (default) or registered (newest-registered first). Server-side.", allowed: ["name", "registered"] },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, type, registeredAt }> + truncated:boolean · with --full the items add { address, postalCode, city, email, contactPersonId, shortName, comment, companyDescription, roolit:{isTyomaaAsiakas,isPumppuToimittaja,isBetoniToimittaja,isLattiaToimittaja} } · with --include each item adds contacts:[{personId,name,phone,email,contactPersonTypeId}] and/or sijainnit:[{sijaintiId,name,lyh,address,sijaintiTypeId,maxDeliveryDistance,jerryActiveUntil}] · with --ids the response adds missing:[{asiakasId, reason:'not_owned'|'not_found'}] for requested ids that didn't return",
    errors: permErrors("auth.page.asiakas.read"),
    notes: [
      "Scope: regular users see their own tenant + their own company row; SYSTEM ADMINS list across ALL tenants (incl. cross-tenant --ids).",
      "--full returns every flat-customer field + the jerry companyDescription in one call (diff a whole tenant without N×`customer get`).",
      "--full also carries `roolit` per row, so 'which of my customers are pump providers?' is ONE call: `ib customer list --full --fields name,roolit` (needs the 2026-08-10 backend; older deployments omit the field).",
      "--ids 1,2,3 restricts to specific asiakasIds and returns ALL of them (NOT capped at the default 100 — bounded by the ids list, max 1000) — the efficient way to refresh only the rows you care about.",
      "Without --ids the list is capped (default 100 / max 500) and `truncated:true` flags when you hit the cap (narrow with --ids or raise --limit).",
      "--fields / --sijainti-types trim what you ingest: project to the columns you diff and keep only the location types you care about (e.g. varikko/asema). Server-side on a deployed backend, with a client-side fallback so they work pre-deploy.",
      "registeredAt (the customer's registration timestamp) is on every row — combine --since (e.g. --since yesterday) with --sort registered for a 'new customers in the last 24h' report, incl. cross-tenant for system admins. --since/--sort are server-side (no client-side fallback — the server truncates at --limit before any client filter could run), so they need the backend deploy.",
    ],
    examples: [
      "ib customer list",
      "ib customer list --limit 50 --pretty",
      "ib customer list --full",
      "ib customer list --ids 26,42,1349 --full",
      "ib customer list --ids 26,42 --full --include contacts,sijainnit",
      "ib customer list --ids 26 --full --fields name,address,postalCode,city,contactPersonId,companyDescription",
      "ib customer list --ids 26 --include sijainnit --sijainti-types 1,2",
      "ib customer list --since yesterday --sort registered",
    ],
  },
  {
    command: "ib customer dead-list",
    description: "List customers flagged dead/caution by the PRH nightly business-registry sweep.",
    permissions: ["auth.page.asiakas.read"],
    flags: [
      { name: "limit", type: "number", default: "200", description: "Max rows (capped at 500)." },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, prhStatus:'dead'|'caution', prhSituation, prhCheckedAt }> — dead rows first, then most-recently-checked.",
    errors: permErrors("auth.page.asiakas.read"),
    notes: [
      "Reads the prhStatus columns written by the nightly PRH sweep (puminet7) — not a live PRH lookup.",
      "Scope: own tenant; system admins see all tenants.",
      "`dead` = konkurssi/selvitystila/purettu (won't pay); `caution` = yrityssaneeraus (sell with care / prepay).",
    ],
    examples: ["ib customer dead-list", "ib customer dead-list --pretty", "ib customer dead-list --limit 50"],
  },
  {
    command: "ib customer get",
    description:
      "Get a single customer (asiakas) by id: flat contact fields + roolit (what the company IS — pump/concrete/floor supplier, worksite customer).",
    permissions: ["auth.page.asiakas.read"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to fetch" }],
    flags: [],
    outputShape:
      "{ asiakasId, name, yTunnus, type, address, postalCode, city, email, phone, contactPersonId, shortName, comment, registeredAt, roolit:{ isTyomaaAsiakas, isPumppuToimittaja, isBetoniToimittaja, isLattiaToimittaja } }",
    errors: [
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...permErrors("auth.page.asiakas.read"),
    ],
    notes: [
      "roolit is the answer to 'what is this company?' — isPumppuToimittaja is what gates every provider-side pumppuRequest endpoint (and the frontend's jerry page), so read it rather than inferring the business from the free-text `comment`. The two DO diverge: a comment can say the pumping business was sold while isPumppuToimittaja is still true.",
      "roolit is the same sub-shape `customer modules` reports, minus the 8 module flags — those need the admin-gated read (`ib customer modules <id>`), this one only needs asiakas.read.",
      "roolit needs the 2026-08-10 backend; against an older deployment the field is simply absent (not false).",
    ],
    seeAlso: ["ib customer modules", "ib customer settings", "ib customer list"],
    examples: ["ib customer get 1349"],
  },
  {
    command: "ib customer worksites",
    description: "List worksites belonging to a customer (GET /api/tyomaa/asiakasTyomaaList/:asiakasId).",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId" }],
    flags: [],
    outputShape: "ListEnvelope<{ tyomaaId, name, address, city }>",
    errors: [...permErrors("auth.page.tyomaa.read")],
    examples: ["ib customer worksites 1349"],
  },
  {
    command: "ib customer create",
    description:
      "Create a customer. Typed flags assemble the createY body (yTunnus REQUIRED); --from-prh prefills name+yTunnus+billing address from the PRH registry; --address/--postal-code/--city set the billing postal address; --body raw JSON overrides flags. Returns the flat customer shape via re-fetch.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "ytunnus", type: "string", description: "Business ID (yTunnus) — required unless --from-prh/--body supplies it" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "from-prh", type: "string", description: "Prefill name + yTunnus + billing address from PRH for this business ID" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "get-or-create", type: "boolean", description: "If a customer with this yTunnus already exists, return it (reused:true) instead of creating a duplicate" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "flat customer { asiakasId, name, yTunnus, type, address, postalCode, city, email, contactPersonId, shortName, comment } (or wouldCreate on --dry-run; with --get-or-create adds reused:boolean)",
    errors: [
      apiErr(400, "Missing yTunnus / validation, or >1 customer shares the yTunnus with --get-or-create", "pass --ytunnus or --from-prh; for an ambiguous match use `ib customer get <id>`"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer create --from-prh 0145937-9 --email billing@x.fi --reason onboard",
      "ib customer create --name 'Example Oy' --ytunnus 1234567-8",
      "ib customer create --from-prh 0145937-9 --get-or-create --reason onboard",
    ],
  },
  {
    command: "ib customer update",
    description:
      "Update a customer via read-merge-write: reads the current record, overlays the provided flags (preserving everything else — no contact-person clobber), writes back with saveGlobalAsiakas. --from-prh refreshes name+yTunnus+billing address from the registry (explicit flags still win). Billing postal address (--address/--postal-code/--city) is writable; pass an empty string to clear a field (" + clearNote("--address") + "). --body raw JSON overrides flags.",
    permissions: ["auth.page.asiakas.edit"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to update" }],
    flags: [
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "ytunnus", type: "string", description: "Business ID (ytunnus)" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "comment", type: "string", description: "Comment (kommentti)" },
      { name: "contact-person", type: "number", description: "Single PRIMARY contact personId (asiakasContactPersonId) — for memberships use `customer person add` (see docs: asiakas-contact-person-model)" },
      { name: "type", type: "number", description: "Customer type id (asiakasTypeId)" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "from-prh", type: "string", description: "Refresh name + yTunnus + billing address from PRH (explicit flags still win)" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "flat customer shape + changed:boolean|null (whether anything actually changed vs an idempotent no-op; null = undetermined) · wouldUpdate on --dry-run",
    errors: [
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer update 26 --email new@x.fi --reason 'email change'",
      "ib customer update 26 --name 'Renamed Oy'",
    ],
  },
  {
    command: "ib customer create-or-update",
    aliases: ["ib customer upsert"],
    description:
      "Upsert a customer keyed by business ID (ytunnus) — removes the search-then-create dance for idempotent onboarding. Looks the ytunnus up in your tenant (system admins: across tenants); 1 match → update (read-merge with your flags), 0 → create, >1 → error (exit 4). --from-prh <yt> uses that business ID as the key AND prefills name+yTunnus from PRH on create. Alias: `ib customer upsert`.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "ytunnus", type: "string", description: "Business ID key (yTunnus) — required unless --from-prh/--body supplies it" },
      { name: "from-prh", type: "string", description: "Use this business ID as the key AND prefill name+yTunnus+billing address from PRH on create" },
      { name: "name", type: "string", description: "Customer name (asiakasNimi)" },
      { name: "email", type: "string", description: "Invoicing email (laskutusEmail)" },
      { name: "short-name", type: "string", description: "Short display name (asiakasShortNimi)" },
      { name: "comment", type: "string", description: "Comment (kommentti) — applied on create or update" },
      { name: "contact-person", type: "number", description: "Contact person id — applied on update" },
      { name: "type", type: "number", description: "Customer type id — applied on update" },
      { name: "address", type: "string", description: "Billing street address (laskutusOsoite)" },
      { name: "postal-code", type: "string", description: "Billing postal code (laskutusPostinumero)" },
      { name: "city", type: "string", description: "Billing city (laskutusKaupunki)" },
      { name: "body", type: "json", description: "Raw JSON body (overrides typed flags) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ...flat customer, action: 'created'|'updated' } (action 'updated' also carries changed:boolean|null) · { action: 'would-*', dryRun } on --dry-run",
    errors: [
      apiErr(400, "No ytunnus key, or >1 customers share the ytunnus (ambiguous)", "provide --ytunnus/--from-prh; for an ambiguous match use `ib customer update <id>`"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: [
      "ib customer create-or-update --from-prh 1234567-8 --reason 'PRH onboarding'",
      "ib customer upsert --ytunnus 1234567-8 --name 'Example Oy' --email billing@example.fi --reason onboard",
    ],
  },
  {
    command: "ib customer search",
    description:
      "Free-text search across customer names / yTunnus / contacts. GET /api/asiakas/search?searchString=...",
    permissions: ["auth.page.asiakas.read"],
    args: [{ name: "query", type: "string", required: false, description: "search string (or pass --search)" }],
    flags: [
      {
        name: "search",
        type: "string",
        description: "Search query (alias for the <query> positional)",
      },
      {
        name: "limit",
        type: "number",
        default: "50",
        description: "Max results",
      },
      {
        name: "my-companies",
        type: "boolean",
        description: "Search across every company you belong to (customer/worksite/person)",
      },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, name, yTunnus, score }>",
    errors: permErrors("auth.page.asiakas.read"),
    examples: ["ib customer search Example", "ib customer search 1234567"],
  },
  {
    command: "ib customer modules",
    description:
      "Report or toggle a TENANT's roolit + module flags — any asiakas you administer, your own company included (there is no `ib company modules`).",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId to report/modify (or pass --asiakas)" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description: "Target asiakasId (alias for the positional)",
      },
      {
        name: "set",
        type: "string",
        description: "Comma-separated field keys to turn ON",
      },
      {
        name: "unset",
        type: "string",
        description: "Comma-separated field keys to turn OFF",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "report: { asiakasId, roolit:{...}, modules:{...} } | write: { asiakasId, applied:{ set, unset, dryRun }, state:{ roolit, modules } }",
    errors: [
      apiErr(400, "Unknown field key, or key in both --set and --unset", "use only: pumppu/jerry/henkilot/sijainnit/ajoneuvot/tiedostot/weather/lomaseuranta/shareorders"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Field keys: pumppu (isPumppuToimittaja), jerry, henkilot, sijainnit, ajoneuvot, tiedostot, weather, lomaseuranta, shareorders.",
      "Without --set/--unset it is a read-only report (GET /api/cli/customer/modules/:asiakasId); with them it routes pumppu → POST /api/asiakas/setRoolit and modules → POST /api/asiakas/settings/save.",
      "The target accepts either the positional <asiakasId> or --asiakas <id> (same flag as the rest of customer/*); pass one — including for your own company, whose id is `ib company current`.",
    ],
    seeAlso: ["ib customer settings", "ib company current"],
    examples: [
      "ib customer modules 1349",
      "ib customer modules --asiakas 1349 --set jerry,weather,pumppu --reason 'enable operator features'",
      "ib customer modules 1349 --unset shareorders --dry-run",
    ],
  },
  {
    command: "ib customer operator",
    description:
      "Verify or provision the full operator preset — all 9 operator flags at once (pumppu + the 8 modules). Default (no flag): verify, exit 0 iff every flag is on else exit 1 (CI-gateable). --set turns all 9 on; --reset turns all 9 off. System-admin can run cross-tenant.",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId to verify/provision (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "set", type: "boolean", description: "Turn ALL 9 operator flags ON" },
      { name: "reset", type: "boolean", description: "Turn ALL 9 operator flags OFF" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "verify: { asiakasId, allSet, flags:{ pumppu, jerry, … }, missing:[…] } (exit 1 when allSet=false) | set/reset: { asiakasId, applied:{ set, unset, dryRun }, state }",
    errors: [
      apiErr(400, "--set and --reset both given", "pass at most one of --set / --reset"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      "ib customer operator 1349",
      "ib customer operator --asiakas 1349 --set --reason 'onboard operator'",
      "ib customer operator 1349 --reset --reason 'offboard operator'",
    ],
  },

  {
    command: "ib customer duplicates",
    description:
      "List likely-duplicate customer pairs for one tenant (y-tunnus / exact-name / email / name-prefix matches). Read-only; system-admin gated server-side. Owner defaults to your active company; --owner scans another tenant. Feeds `ib customer merge`.",
    permissions: ["system admin (or company admin on the target tenant)"],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId to scan (default: active company)" },
    ],
    outputShape:
      "{ items: [{ id1, name1, id2, name2, matchCode: 'ytunnus'|'exact_name'|'email'|'name_prefix', matchValue, confidence: 'high'|'low' }], count, truncated? } — truncated=true when capped at 100 pairs",
    errors: [
      apiErr(400, "ownerAsiakasId missing/invalid", "pass --owner <id>, or set an active company"),
      apiErr(403, "Not permitted on this tenant", "use a system-admin token"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "name_prefix is a low-confidence heuristic (same distinctive name-start after stripping generic lead-words like Rakennusliike / Kiinteistö Oy) — a human confirms before merging.",
      "Each pair is returned once (id1 < id2), top 100 by match confidence.",
    ],
    seeAlso: ["ib customer merge", "ib customer get"],
    examples: ["ib customer duplicates", "ib customer duplicates --owner 1349"],
  },

  {
    command: "ib customer merge",
    description:
      "Merge two duplicate customers: the secondary's references move onto the main, then the secondary is DELETED. IRREVERSIBLE and system-admin gated. --dry-run runs the read-only /validate safety check (what would move + conflicts) and NEVER merges. A real merge requires --reason.",
    permissions: ["system admin (or company admin on the target tenant)"],
    flags: [
      { name: "main", type: "number", description: "asiakasId to KEEP — references merge into this one (required)" },
      { name: "secondary", type: "number", description: "asiakasId to REMOVE — merged away then deleted (required)" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "allow-big-merge", type: "boolean", description: "System-admin: permit a merge above the safety row cap" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    reasonDetail: "(customer merge is irreversible; --dry-run previews via /validate)",
    dryRunKind: "client",
    outputShape:
      "real: { success, safetyValidation, timestamp, ... } | dry-run: { dryRun: true, validation: { success, ... } }",
    errors: [
      apiErr(400, "Validation failed (missing/equal ids, or safety row cap)", "check --main/--secondary; run --dry-run first; a system-admin may add --allow-big-merge"),
      apiErr(403, "Not permitted on this tenant", "use a system-admin token"),
      apiErr(404, "One or both customers not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.",
      "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.",
      "Affects keikka / tyomaa / person / sijainti / stat / lasku rows and the change history; caches are invalidated server-side.",
    ],
    seeAlso: ["ib customer duplicates", "ib customer delete"],
    examples: [
      "ib customer merge --main 8001 --secondary 8002 --dry-run",
      "ib customer merge --main 8001 --secondary 8002 --reason 'dedupe: same y-tunnus'",
    ],
  },

  {
    command: "ib customer log",
    description:
      "Change-tracker audit trail for one customer — who changed which field, when, and the --reason. Reads the same log the CLI's writes populate.",
    permissions: ["auth.page.asiakas.read (company member or admin)"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId" }],
    flags: [
      { name: "limit", type: "number", default: "100", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, field, oldValue, newValue, changeType, personId, personName, at, description, reason }>" +
      LOG_CAPPED_NOTE,
    errors: permErrors("auth.page.asiakas.read"),
    examples: ["ib customer log 26", "ib customer log 26 --limit 20"],
  },
  {
    command: "ib customer settings",
    description:
      "Report or toggle ALL asiakasSettings (every canonical ASIAKAS_SETTING_TYPE_IDS name) plus pumppu, for any TENANT you administer — your own company included (there is no `ib company settings`). Without --set/--unset it is a read-only report. Names are case-insensitive; the 8 module aliases (jerry, weather, …) and pumppu are also accepted. Superset of `customer modules`.",
    permissions: ["company admin on the target tenant (system admin = any tenant)"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "set", type: "string", description: "Comma-separated setting names to turn ON" },
      { name: "unset", type: "string", description: "Comma-separated setting names to turn OFF" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "report: { asiakasId, roolit:{…}, settings:{ HAS_FENNOA:bool, ALV:bool, … every setting } } | write: { asiakasId, applied:{set,unset,dryRun}, state }",
    errors: [
      apiErr(400, "Unknown setting name, or name in both --set/--unset", "use a canonical ASIAKAS_SETTING_TYPE_IDS name, an alias, or pumppu"),
      apiErr(403, "Not an admin of this tenant", "use a system-admin token, or an admin of the owner company"),
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib customer modules", "ib company current"],
    examples: [
      "ib customer settings 1349",
      "ib customer settings --asiakas 1349 --set HAS_FENNOA,ALV --unset HAS_OCR --reason 'billing setup'",
    ],
  },

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
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
      { name: "cursor", type: "string", description: "Pagination cursor" },
    ],
    outputShape:
      "ListEnvelope<{ tyomaaId, name, address, asiakasId, city }>" + TRUNCATED_NOTE,
    errors: permErrors("auth.page.tyomaa.read"),
    examples: ["ib worksite list", "ib worksite list --customer 1349"],
  },
  {
    command: "ib worksite get",
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
      apiErr(400, "No fields to update", "pass at least one typed flag or a --body/--from-json patch"),
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
      {
        name: "search",
        type: "string",
        description: "Search query (alias for the <query> positional)",
      },
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
    errors: permErrors("auth.page.tyomaa.read"),
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
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by fieldName" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
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
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
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
      "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.",
      "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.",
      "Affects keikka / person / grid rows and the change history; caches are invalidated server-side.",
    ],
    seeAlso: ["ib worksite duplicates", "ib worksite delete"],
    examples: [
      "ib worksite merge --main 701 --secondary 702 --dry-run",
      "ib worksite merge --main 701 --secondary 702 --reason 'dedupe: same address'",
    ],
  },

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
        description: "Filter by role name (e.g. driver, admin, laskuAdmin)",
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
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
    ],
    outputShape:
      "ListEnvelope<{ personId, name, email, roles:number[] }>" + TRUNCATED_NOTE,
    errors: [
      apiErr(400, "Unknown role", "use a role from @ibetoni/constants ROLE_TYPEID_BY_NAME"),
      ...permErrors("auth.page.person.read"),
    ],
    notes: [
      "This command does NOT search by name — it enumerates and filters by role/company. To find a person by name or email use `ib person search <query>` (which also accepts `--search`).",
    ],
    seeAlso: ["ib person search"],
    examples: [
      "ib person list",
      "ib person list --owned",
      "ib person list --asiakas 1349 --limit 50",
    ],
  },
  {
    command: "ib person get",
    description:
      "Get a single person by personId. Global persons (ownerAsiakasId=null) are fetchable by anyone. --asiakas reads a person owned by ANOTHER company (cross-tenant; developer/admin lever) — without it the lookup is scoped to the active company and a foreign personId returns 404.",
    permissions: ["auth.page.person.read"],
    args: [{ name: "personId", type: "number", description: "personId to fetch" }],
    flags: [
      {
        name: "asiakas",
        type: "number",
        description:
          "Read a person owned by this company (cross-tenant). Requires membership of that company, or sysadmin/developer; default = active company.",
      },
    ],
    outputShape:
      "{ personId, name, email, phone, roles:number[] }",
    errors: [
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      apiErr(
        403,
        "Not a member of the --asiakas company",
        "cross-tenant person reads need membership of the target company, or sysadmin/developer. Check what you can reach with `ib company list`."
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
      "Global persons (ownerAsiakasId=null) are included in every company's results.",
    permissions: [
      "auth.page.person.read",
      "--asiakas: a company you belong to, or sysadmin/developer for any tenant",
      "--all-companies: sysadmin/developer (server-enforced)",
    ],
    args: [{ name: "query", type: "string", required: false, description: "search string (or pass --search)" }],
    flags: [
      {
        name: "search",
        type: "string",
        description: "Search query (alias for the <query> positional)",
      },
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
    command: "ib person role list",
    description:
      "List a person's per-company roles (asiakasPersonSettings) for a given asiakas. Role names resolved via ROLE_NAME_BY_TYPEID.",
    permissions: ["company role read on the target tenant"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasPersonSettingId, roleTypeId, role: string|null }>",
    errors: permErrors("company role access on the tenant"),
    examples: ["ib person role list 5351 --asiakas 26"],
  },
  {
    command: "ib person role grant",
    description:
      "Grant a per-company role to a person. POST /api/asiakasPersonSettings/add/:asiakasId/:personId/:roleTypeId. Admin-gated on the tenant (tier depends on the role). --dry-run previews via the backend ({ dryRun:true, wouldCreate }).",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "role", type: "string", description: "Role name (REQUIRED), e.g. keikkaHandler, vehicleHandler, hrAdmin" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ granted: { personId, asiakasId, roleTypeId } } | { dryRun:true, wouldCreate:{ personId, asiakasId, personSettingTypeId, personSettingString }, validation }",
    errors: [
      ROLE_NAME_CLIENT_ERROR,
      apiErr(400, "Unknown role / company limit reached", "use a name from ROLE_TYPEID_BY_NAME"),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "\"TarjousAdmin\" is NOT a usable --role value: the name denotes two different roles. laskupohjaAdmin (typeId 1) is what dbo.asiakasPersonSettingTypes + @ibetoni/constants call isTarjousAdmin, and is what the BetoniJerry email-recipient fallback and `ib jerry admin detail`.admins read; laskuAdmin (typeId 5) is what the Jerry admin dashboard's tarjousAdminCount and the Jerry validation profile's people.tarjousAdmin check read. Granting the documented one leaves Jerry validation red with a message saying you granted nothing — pass the explicit name instead (fb#418).",
    ],
    examples: [
      "ib person role grant 5351 --role keikkaHandler --asiakas 26 --reason 'onboard handler'",
      "ib person role grant 5351 --role vehicleHandler --asiakas 26 --reason preview --dry-run",
    ],
  },
  {
    command: "ib person role revoke",
    description:
      "Revoke a per-company role from a person (idempotent: { removed:0 } when absent). Looks up the asiakasPersonSettingId then DELETEs it. --dry-run previews via the backend ({ dryRun:true, wouldDelete }).",
    permissions: ["company admin on the target tenant (tier per role)"],
    args: [{ name: "personId", type: "number", description: "personId" }],
    flags: [
      { name: "role", type: "string", description: "Role name (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: 1 } | { removed: 0 } (absent) | { dryRun:true, wouldDelete:{ asiakasPersonSettingId }, validation }",
    errors: [
      ROLE_NAME_CLIENT_ERROR,
      apiErr(400, "Unknown role", "use a name from ROLE_TYPEID_BY_NAME"),
      apiErr(403, "Not a tenant admin", "use a system-admin token or a tenant admin"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib person role revoke 5351 --role keikkaHandler --asiakas 26 --reason rotation"],
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
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by changeTracker fieldName (e.g. asiakasPersonSetting for role changes)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, field, oldValue, newValue, changeType, personId, personName, at, description, reason }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      apiErr(403, "Not a member of that company (and not admin)", "ib company switch to that owner, or use an admin token")
    ),
    examples: ["ib person log 63", "ib person log 63 --field asiakasPersonSetting", "ib person log 63 --owner 27 --limit 50"],
  },
  {
    command: "ib person duplicates",
    description:
      "List likely-duplicate person pairs for one tenant: same normalized phone (high), same email (high), or same first+last name (medium). Both rows must be older than 1 month. Read-only; admin gated server-side. Owner defaults to your active company; --owner scans another tenant. Feeds `ib person merge`.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId to scan (default: active company)" },
    ],
    outputShape:
      "{ items: [{ id1, name1, id2, name2, matchCode: 'phone'|'email'|'full_name', matchValue, confidence: 'high'|'medium' }], count, truncated? } — truncated=true when capped at 100 pairs",
    errors: [
      apiErr(400, "ownerAsiakasId missing/invalid", "pass --owner <id>, or set an active company"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "full_name is a medium-confidence heuristic (identical first+last name) — a human confirms before merging.",
      "Each pair is returned once (id1 < id2), top 100 by confidence.",
    ],
    seeAlso: ["ib person merge", "ib person get"],
    examples: ["ib person duplicates", "ib person duplicates --owner 1349"],
  },
  {
    command: "ib person merge",
    description:
      "Merge two duplicate persons: the secondary's references (keikka / vehicle / tyomaa / asiakas / betoni / tuote) move onto the main, then the secondary is DELETED. IRREVERSIBLE and admin gated; every merge is audited server-side. --dry-run runs the read-only /validate safety check (what would move + conflicts) and NEVER merges. A real merge requires --reason.",
    permissions: ["company admin on the tenant (system admin for another owner)"],
    flags: [
      { name: "main", type: "number", description: "personId to KEEP — references merge into this one (required)" },
      { name: "secondary", type: "number", description: "personId to REMOVE — merged away then deleted (required)" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    reasonDetail: "(person merge is irreversible; --dry-run previews via /validate)",
    dryRunKind: "client",
    outputShape:
      "real: { success, safetyValidation, timestamp, ... } | dry-run: { dryRun: true, validation: { success, ... } }",
    errors: [
      apiErr(400, "Validation failed (missing/equal ids, or safety check)", "check --main/--secondary; run --dry-run first"),
      apiErr(403, "Not permitted on this tenant", "ib company switch to that owner, or use an admin token"),
      apiErr(404, "One or both persons not found or access denied", "verify --main/--secondary and --owner"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "ALWAYS --dry-run first: the /merge route has no X-Dry-Run guard, so a real invocation merges immediately.",
      "--dry-run issues a read-only POST to /validate (tagged `read`), so it runs even under --read-only / IB_READ_ONLY; only a real merge is blocked by the write-lock.",
      "Affects keikka / vehicle / tyomaa / asiakas / betoni / tuote rows and the change history; caches are invalidated server-side; a pre-merge snapshot is written to the person combinator audit log.",
    ],
    seeAlso: ["ib person duplicates", "ib person delete"],
    examples: [
      "ib person merge --main 6001 --secondary 6002 --dry-run",
      "ib person merge --main 6001 --secondary 6002 --reason 'dedupe: same phone'",
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
    description: "List a person's day rows (status / vehicle / text) over a date range",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "from", type: "date", description: "Start date YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "End date YYYY-MM-DD (default: --from)" },
    ],
    outputShape: "ListEnvelope<{ personPvmId, date, statusId, status, pois, vehicleId, text }>",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "Scoped to the active company (same-tenant).",
      "`status` is the personPvmStatus code; map statusId→friendly name via `ib person day statuses`.",
    ],
    seeAlso: ["ib person day set", "ib vehicle driver who"],
    examples: ["ib person day get --person 555 --from today", "ib person day get --person 555 --from 2026-06-01 --to 2026-06-30"],
  },
  {
    command: "ib person day set",
    description: "Set a person's day availability status (vacation/sick/free/…). Requires --reason.",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
      { name: "status", type: "string", description: "personPvmStatusId or status name (see `ib person day statuses`)", required: true },
      { name: "text", type: "string", description: "Free-text note on the day row" },
    ],
    writeFlags: true,
    reasonPolicy: "always",
    mutates: true,
    dryRunKind: "client",
    outputShape: "personPvm save result | { dryRun:true, personId, date, wouldChange:{ status?, text? } } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason or unknown/ambiguous --status", "supply --reason; check `ib person day statuses`"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced) — Keikka Handler is NOT sufficient.",
      "--status accepts an id or a name (resolved via `ib person day statuses`).",
      "--reason is hard-required (exits 4 without it).",
      "Read-merges the existing row so a re-set updates in place (no duplicate) and PRESERVES the existing vehicle assignment. It cannot CHANGE the vehicle — use `ib vehicle driver assign` for that (atomic).",
    ],
    seeAlso: ["ib person day statuses", "ib person day clear", "ib vehicle driver assign"],
    examples: [
      "ib person day set --person 555 --date tomorrow --status loma --reason 'kesäloma'",
      "ib person day set --person 555 --date 2026-06-10 --status 2 --dry-run --reason preview",
    ],
  },
  {
    command: "ib person day clear",
    description: "Delete a person's day row for a date (remove status entry). Requires --reason.",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "personId", required: true },
      { name: "date", type: "date", description: "Day YYYY-MM-DD (or today/yesterday/tomorrow)", required: true },
    ],
    writeFlags: true,
    reasonPolicy: "always",
    mutates: true,
    dryRunKind: "client",
    outputShape: "delete result | { dryRun:true, wouldDelete:{ personPvmId, date, status } | null } (with --dry-run)",
    errors: [
      apiErr(400, "Missing --reason", "supply --reason"),
      apiErr(403, "Requires Admin or HR Admin on the active company", "use an Admin/HR account"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires Admin or HR Admin (server-enforced).",
      "--reason is hard-required (exits 4 without it).",
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
    errors: permErrors("auth.page.grid.read"),
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
    command: "ib person activity",
    description:
      "Login / security-event / impersonation history for one person: lastLoginTime, personLog type-1 logins, SecurityEventLog rows for the person's email — all event types (SUCCESSFUL_LOGIN plus lockout/brute-force/rate-limit), each with eventType/method/ip (source once persisted) — and impersonation rows as-target and as-actor. Developer-only — the data includes IPs/emails.",
    permissions: ["developer access (isSystemAdmin or isDeveloper)"],
    tier: "developer",
    args: [{ name: "personId", type: "number", description: "person.personId" }],
    flags: [
      { name: "limit", type: "number", default: "100", description: "Max rows per list (capped at 1000)" },
    ],
    outputShape:
      "{ personId, email, lastLoginTime, logins:[{entryTime}], securityEvents:[{eventType,method,source,ip,timestamp}], impersonations:{ asTarget:[{actorPersonId,entryTime,type,sessionId,endReason?}], asActor:[{targetPersonId,entryTime,type,sessionId,endReason?}] } }",
    errors: [
      apiErr(400, "personId is not a positive integer", "pass a numeric personId"),
      apiErr(404, "no person with that id", "check the id with `ib person get <id>`"),
      ...permErrors("developer access (isSystemAdmin or isDeveloper)"),
    ],
    notes: [
      "Developer-gated server-side and hidden from non-developer discovery.",
      "personLog type-1 counts credential logins AND token-refresh/impersonation bootstraps; cross-check securityEvents (credential-only) to tell them apart. Deploy-gated (no-op until the puminet5api backend deploys).",
    ],
    seeAlso: ["ib person log", "ib person get"],
    examples: ["ib person activity 63", "ib person activity 63 --limit 20"],
  },

  // ─── vehicle (16) ─────────────────────────────────────────────────────────
  {
    command: "ib vehicle list",
    description:
      "List vehicles visible to the active company. ownerAsiakasId derived from JWT. Rows are self-describing (showInGrid/firstDate/lastDate/deletedTime). Default scope = non-deleted with no narrowing, so grid-hidden AND expired vehicles ARE included; only soft-deleted are excluded. Use the flags to narrow or to reveal deleted rows. --asiakas lists ANOTHER company's fleet (cross-tenant; developer/admin lever) instead of the active company.",
    permissions: ["auth.page.vehicle.read", VEHICLE_ASIAKAS_PERMISSION],
    seeAlso: ["ib vehicle types"],
    flags: [
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows (capped at 500)",
      },
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
      { name: "search", type: "string", description: "Search query (alias for the <query> positional)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
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
      apiErr(403, "No access to this tenant's vehicles (--asiakas)", "you need an admin/owner/vehicleHandler role on the target tenant"),
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
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by fieldName (e.g. vehicleRegNo)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
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

  // ─── notification (2) ─────────────────────────────────────────────────────
  {
    command: "ib notification fcm send",
    description:
      "Send an FCM push notification to one person's registered devices. Admin/HR-gated server-side; the recipient is scoped to your company (a cross-tenant personId returns 404, not a push). --dry-run previews the recipient + active device count without sending.",
    tier: "admin",
    permissions: [
      "company admin (isAsiakasAdmin) or HR admin (isHRAdmin) on the active company, or global sysadmin (server-enforced)",
    ],
    flags: [
      { name: "person", type: "string", description: "Recipient personId, or a name resolved within your company", required: true },
      { name: "title", type: "string", description: "Notification title", required: true },
      { name: "body", type: "string", description: "Notification body", required: true },
      { name: "data", type: "string", description: "Extra FCM data payload as a JSON object (e.g. '{\"url\":\"/grid\"}')" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ success, reason:'SENT'|'NO_DEVICES'|'DELIVERY_FAILED', personId, name, devicesTargeted, messageUuid?, successCount?, failureCount?, hint? } | { dryRun:true, wouldSend:{ personId, name, title, body, deviceCount } } (with --dry-run)",
    errors: [
      apiErr(400, "Invalid request: missing --title/--body, bad --person, ambiguous name, or non-object --data (NOT 'no devices' — that is a 200, see notes)", "supply --title/--body and an unambiguous --person"),
      apiErr(403, "Not Admin/HR on the active company", "switch to a company where you are admin/HR (ib company switch)"),
      apiErr(404, "Recipient not found in your company", "check the personId / name belongs to your company"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Requires company admin (isAsiakasAdmin) or HR admin (isHRAdmin) on the active company, or a global sysadmin.",
      "A non-numeric --person is resolved via the company-scoped person search: 0 matches → exit 5, >1 → exit 4 listing candidates (re-run with the personId).",
      "The send OUTCOME is reported at HTTP 200 (exit 0) via `reason` — NOT as an error: SENT, NO_DEVICES (the person has no registered FCM device — a benign no-op), or DELIVERY_FAILED (all devices failed). Inspect `success`/`reason`/`hint`, not the exit code; a 4xx means the REQUEST was bad (validation/permission/recipient), not that delivery failed.",
    ],
    seeAlso: ["ib person notify", "ib person search"],
    examples: [
      "ib notification fcm send --person 6233 --title 'Keikka siirretty' --body 'Huomisen keikka alkaa klo 8'",
      "ib notification fcm send --person 'Juha Urho' --title Muistutus --body 'Tarkista aikataulu' --dry-run",
    ],
  },
  {
    command: "ib notification email send",
    description:
      "Send an email to one person (resolved within your company) or a raw address. Admin/HR/developer-gated server-side. Pick the sender domain with --from-brand (betoni=noreply@ibetoni.fi default, betonijerry=noreply@betonijerry.fi bypassing the demo reroute). One of --body/--html/--html-body required; --dry-run previews the resolved recipient + sender without sending.",
    tier: "admin",
    permissions: [
      "company admin (isAsiakasAdmin), HR admin (isHRAdmin), or global developer/sysadmin (server-enforced)",
    ],
    args: [
      {
        name: "recipient",
        type: "string",
        description:
          "personId, a name resolved within your company, or a raw email address (contains '@')",
      },
    ],
    flags: [
      { name: "subject", type: "string", description: "Email subject", required: true },
      { name: "body", type: "string", description: "Plain-text body (auto-wrapped to HTML)" },
      {
        name: "html",
        type: "string",
        description: "Path to an HTML file sent as the HTML body (avoids argv mangling of ä/ö)",
      },
      {
        name: "html-body",
        type: "string",
        description:
          "Inline raw HTML body — use instead of --html for MCP/remote callers (argv-safe, no local file read)",
      },
      {
        name: "from-brand",
        type: "string",
        description:
          "Sender identity: betoni (default, noreply@ibetoni.fi) or betonijerry (noreply@betonijerry.fi)",
      },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ sent:true, to, from, subject } | { dryRun:true, wouldSend:{ to, from, subject, hasHtml } } (with --dry-run)",
    errors: [
      apiErr(
        400,
        "Missing --subject, none of --body/--html/--html-body, --html and --html-body both set, bad --from-brand, recipient has no email on file, or both/neither of personId+email",
        "supply --subject, one of --body/--html/--html-body, and a valid --from-brand"
      ),
      apiErr(
        403,
        "Not Admin/HR/developer",
        "switch to a company where you are admin/HR (ib company switch), or use a developer/sysadmin token"
      ),
      apiErr(
        404,
        "Recipient personId not found in your company",
        "check the personId / name belongs to your company"
      ),
      apiErr(
        422,
        "Email provider (SendGrid) rejected the send — e.g. the From address/domain is not a verified Sender Identity (notably --from-brand betonijerry until betonijerry.fi is authenticated in SendGrid)",
        "a provider/config issue, not your request — authenticate the sending domain in SendGrid (Sender Authentication); the exact SendGrid reason is in the error message"
      ),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Recipient: a value containing '@' is sent as a raw address; otherwise it is a personId or a name resolved via the company-scoped person search (0 matches → exit 5, >1 → exit 4).",
      "A SendGrid send failure returns 422 with the real provider message (the CDN masks origin 5xx, so 4xx is used to keep the message readable) — it is NOT a caller auth/validation error despite the 4xx code.",
      "--from-brand betonijerry sends as noreply@betonijerry.fi via a DIRECT send that bypasses the BetoniJerry demo-mode reroute — so a deliverability/spam test actually reaches the target inbox.",
      "Useful for spam-score testing: send to a mail-tester.com address and read the SPF/DKIM/DMARC + SpamAssassin score.",
      "Deploy-gated: the /api/cli/notification/email/send route must be deployed before this works.",
    ],
    seeAlso: ["ib notification fcm send", "ib person email list"],
    examples: [
      "ib notification email send web-xxxxx@srv1.mail-tester.com --subject 'deliverability test' --body 'testing' --from-brand betonijerry --reason 'spam check'",
      "ib notification email send 'Juha Urho' --subject Tiedote --html ./notice.html",
      "ib notification email send 5351 --subject Raportti --html-body '<h1>Aamuraportti</h1><p>…</p>' --reason 'morning report over MCP'",
      "ib notification email send 5351 --subject Test --body Hi --dry-run",
    ],
  },
  {
    command: "ib person notify",
    description:
      "Send an FCM push to a person — ergonomic alias for `ib notification fcm send --person <person>`. Admin/HR-gated. <person> is a personId or a name resolved within your company. --dry-run previews recipient + device count.",
    tier: "admin",
    permissions: [
      "company admin (isAsiakasAdmin) or HR admin (isHRAdmin) on the active company, or global sysadmin (server-enforced)",
    ],
    args: [
      { name: "person", type: "string", description: "Recipient personId, or a name resolved within your company" },
    ],
    flags: [
      { name: "title", type: "string", description: "Notification title", required: true },
      { name: "body", type: "string", description: "Notification body", required: true },
      { name: "data", type: "string", description: "Extra FCM data payload as a JSON object" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "Same as `ib notification fcm send` (delegates to it).",
    errors: [
      apiErr(400, "Missing/invalid field (no --title/--body, ambiguous name, non-object --data)", "supply --title/--body and an unambiguous person"),
      apiErr(403, "Not Admin/HR on the active company", "switch to a company where you are admin/HR"),
      apiErr(404, "Recipient not found in your company", "check the personId / name"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: ["Thin alias — same gate, name resolution, and output as `ib notification fcm send`. Deploy-gated."],
    seeAlso: ["ib notification fcm send"],
    examples: [
      "ib person notify 6233 --title 'Keikka siirretty' --body 'Alkaa klo 8'",
      "ib person notify 'Juha Urho' --title Muistutus --body Tarkista --dry-run",
    ],
  },
  {
    command: "ib person email list",
    description:
      "List a person's email addresses — the primary (main:1, person.personEmail) plus any alternatives (main:0, personEmails). Read-only; tenant-scoped to your active company (out-of-scope personId → 404).",
    permissions: ["auth.page.person.read"],
    args: [{ name: "person", type: "string", description: "personId or a name resolved within your active company" }],
    flags: [],
    outputShape: "ListEnvelope<{ email, main: 0|1 }> (main:1 = primary, main:0 = alternative)",
    errors: [
      apiErr(404, "Person not found / out of your tenant", "verify the person is in your active company (or switch company)"),
      ...permErrors("auth.page.person.read"),
    ],
    examples: ["ib person email list 5351", "ib person email list 'Matti Virtanen'"],
  },
  {
    command: "ib person email add",
    description:
      "Add an ALTERNATIVE email to a person (the personEmails one-to-many; the primary is managed via `ib person update`). Tenant-scoped: self, a person owned by your active company, or any person for developers/sysadmins; global persons only by self/developer. Emails are globally unique. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    args: [
      { name: "person", type: "string", description: "personId or a name resolved within your active company" },
      { name: "email", type: "string", description: "alternative email to add (<=250 chars)" },
    ],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ personId, personEmail, added: boolean } · dry-run: { dryRun:true, wouldAdd:{ personId, personEmail } }",
    errors: [
      apiErr(400, "Equals the primary email, or invalid/too-long email", "manage the primary via `ib person update`; check the address"),
      apiErr(404, "Person not found / out of your tenant", "verify the person is in your active company (or switch company)"),
      apiErr(409, "Email already belongs to another person (globally unique)", "use a different address"),
      ...permErrors("auth.page.person.edit"),
    ],
    examples: [
      "ib person email add 5351 matti.alt@example.com --reason 'secondary contact'",
      "ib person email add 5351 matti.alt@example.com --reason preview --dry-run",
    ],
  },
  {
    command: "ib person email set-main",
    description:
      "Promote one of a person's emails to be the PRIMARY (person.personEmail), demoting the previous primary into the alternatives (personEmails). The target must already be an address on this person (primary or alternative). Login is unaffected — every address resolves the person either way; this only changes which one is the displayed/primary address. Idempotent when already primary. Tenant-scoped like `ib person email add`. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    args: [
      { name: "person", type: "string", description: "personId or a name resolved within your active company" },
      { name: "email", type: "string", description: "the person's email to promote to primary (primary or alternative)" },
    ],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ personId, personEmail, main:true, changed:boolean } · dry-run: { dryRun:true, wouldSetMain:{ personId, personEmail } }",
    errors: [
      apiErr(404, "Person not found / out of your tenant, or the email is not on this person", "verify the address belongs to the person (`ib person email list`)"),
      apiErr(409, "Email already belongs to another person (globally unique)", "use a different address"),
      ...permErrors("auth.page.person.edit"),
    ],
    notes: [
      "Deploy-gated: needs the puminet5api /api/person/setMainPersonEmail route AND the dbo.personEmail_setMain proc; until both ship, dry-run and the write both 404.",
    ],
    examples: [
      "ib person email set-main 5351 matti.alt@example.com --reason 'primary contact changed'",
      "ib person email set-main 5351 matti.alt@example.com --reason preview --dry-run",
    ],
  },
  {
    command: "ib person email remove",
    description:
      "Remove an ALTERNATIVE email from a person (personEmails only — cannot remove the primary). Idempotent. Tenant-scoped like `ib person email add`. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    args: [
      { name: "person", type: "string", description: "personId or a name resolved within your active company" },
      { name: "email", type: "string", description: "alternative email to remove" },
    ],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "backend delete result · dry-run: { dryRun:true, wouldDelete:{ personId, personEmail } }",
    errors: [
      apiErr(404, "Person not found / out of your tenant", "verify the person is in your active company (or switch company)"),
      ...permErrors("auth.page.person.edit"),
    ],
    examples: [
      "ib person email remove 5351 matti.alt@example.com --reason 'no longer valid'",
      "ib person email remove 5351 matti.alt@example.com --reason preview --dry-run",
    ],
  },

  // ─── sijainti (14) ───────────────────────────────────────────────────────
  {
    command: "ib sijainti list",
    description:
      "List geocoded locations (sijainnit) — depots, plants, customer destinations. Rows carry a human-readable typeName. --type filters by sijaintiTypeId OR type name (e.g. betoniasema, jäteasema); --search filters by name/address/typeName substring. Default scope is own company + shared rows; pass --all to also see OTHER companies' sijainnit (e.g. supplier betoniasemat — the rows GPS visits/timeline reference).",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "type", type: "string", description: "Filter by sijaintiTypeId or type name (case-insensitive; exact selite match wins, else unique substring — see `ib sijainti types`)" },
      { name: "search", type: "string", description: "Case-insensitive substring over name/address/typeName (client-side scan up to 500 rows; newer backends also pre-filter server-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "valid-at", type: "date", description: "Only sijainnit valid on this date (startDate/endDate window)" },
      { name: "include-deleted", type: "boolean", description: "Include soft-deleted sijainnit" },
      { name: "all", type: "boolean", description: "Include ALL companies' sijainnit, not just own + shared (ownerAsiakasId 0)" },
      { name: "asiakas", type: "number", description: "Only rows owned by this asiakasId (client-side filter on ownerAsiakasId; combine with --all for another company's rows)" },
      { name: "jerry", type: "boolean", description: "BetoniJerry audit lens: only Jerry-enrolled varikot (jerryActiveUntil set; expired included), each stamped with a derived `matchable` boolean" },
      { name: "public", type: "boolean", description: "Only PUBLISHED rows (isPublic=1) — readable cross-tenant by every authenticated user" },
      { name: "private", type: "boolean", description: "Only private rows (isPublic=0) — visible to the owning tenant alone. Mutually exclusive with --public" },
    ],
    outputShape:
      "ListEnvelope<{ sijaintiId, name, address, coords:{lat,lng}, type, typeName, ownerAsiakasId, ownerName, jerryActiveUntil, maxDeliveryDistance, isPublic }> (+matchable:boolean on each row when --jerry is set; +truncated:true when the result hit the limit; +hint pointing at --all / --all --asiakas <id> when 0 rows came back without --all)",
    errors: [
      { origin: "client", exit: 4, match: "sijainti type", meaning: "Unknown or ambiguous --type name", remedy: "the error lists the valid types; or run `ib sijainti types`" },
      { origin: "client", exit: 4, match: "at most one of --public", meaning: "Both --public and --private given", remedy: "pass at most one — omit both to filter nothing" },
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "The list is capped (default 100 / max 500) with NO cursor — `truncated:true` flags a result that filled the limit (raise --limit or narrow with --search/--type). Backend signal needs a backend deployed ≥ 2026-06-11; the client-side --search slice sets it on every backend.",
      "typeName is joined client-side from the sijaintiTypes lookup (one extra GET, automatic); newer backends also emit it directly, plus ownerAsiakasId/ownerName.",
      "jerryActiveUntil (enrolment) + coords + maxDeliveryDistance (km delivery radius) are the set required for a Jerry-enabled varikko to be matchable — a row that is Jerry-active but has null coords or maxDeliveryDistance covers nothing. maxDeliveryDistance is deploy-gated (null on backends older than 2026-07-07). The optional boom range (puomiMin/puomiMax) is NOT in the list — get it via `ib sijainti get <id>`.",
      "Supplier locations (betoniasemat, depots) usually belong to ANOTHER company — without --all they are invisible here even though `ib vehicle visits sijainti <id>` and the GPS timeline reference them. To resolve such a location by name use --search <name> --all, or --all --asiakas <id> when you know the owner company. An empty result without --all carries a `hint` saying exactly this.",
      "--all needs a backend deployed ≥ 2026-06-10; an older backend silently ignores it (returns the own+shared scope). --search works on every backend (client-side fallback).",
      "An unknown numeric --type id is passed through and simply returns zero rows; an unknown type NAME exits 4.",
      "--asiakas filters client-side on the server-emitted ownerAsiakasId field — needs a backend deployed ≥ 2026-06-11 (older backends omit the field, so it matches nothing).",
      "--jerry (fb#108) is a client-side BetoniJerry audit lens: keeps only Jerry-ENROLLED rows (jerryActiveUntil non-null; expired enrolments INCLUDED so lapsed varikot surface) and stamps each with `matchable` = enrolment active (jerryActiveUntil >= now) AND coords present AND maxDeliveryDistance > 0. So `matchable:false` spots an enrolled-but-not-matchable varikko (expired, no GPS pin, or 0 km radius) in ONE command. Boom range (puomiMin/puomiMax) is NOT part of matchable — use `ib sijainti get <id>`.",
      "isPublic is CROSS-TENANT VISIBILITY, not a display preference: 1 = readable by every authenticated user of every tenant (this is how the keikka flow finds a supplier's concrete plants), 0 = the owning tenant only. It moved from the location TYPE to the ROW on 2026-08-14, so two plants of the same type can now differ.",
      "--public/--private filter client-side on isPublic and are DEPLOY-GATED: a backend older than the per-row change omits the field entirely, so there --public matches NOTHING and --private matches EVERYTHING. Check one row carries isPublic before trusting a sweep.",
      "`ib sijainti list --type betoniasema --all --private` is the exposure audit: it names every concrete plant that customers CANNOT see. That is the silent failure mode — a plant created private simply never appears in the tehdas picker, and the keikka editor quietly auto-selects a farther one instead of erroring.",
    ],
    seeAlso: ["ib sijainti plants", "ib sijainti types", "ib sijainti set-jerry", "ib sijainti set-public", "ib search", "ib vehicle visits", "ib vehicle timeline"],
    examples: [
      "ib sijainti list",
      "ib sijainti list --type jäteasema",
      "ib sijainti list --search kivikko --all",
      "ib sijainti list --all --asiakas 30",
      "ib sijainti list --valid-at today",
      "ib sijainti list --jerry",
      "ib sijainti list --type betoniasema --all --private",
    ],
  },
  {
    command: "ib sijainti plants",
    aliases: ["ib sijainti tehtaat"],
    description:
      "List concrete plants (betoniasemat) across ALL companies — sugar for `sijainti list --type betoniasema --all`. Plants belong to supplier companies (Rudus, Lujabetoni, Betset, …), so the default own+shared list scope hides nearly all of them; this command surfaces the whole catalogue. --asiakas narrows to a single company's plants. Alias: `ib sijainti tehtaat`.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "asiakas", type: "number", description: "Only this company's plants (numeric asiakasId; client-side filter on ownerAsiakasId)" },
      { name: "search", type: "string", description: "Case-insensitive substring over name/address (same semantics as `list --search`)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
    ],
    outputShape:
      "ListEnvelope<{ sijaintiId, name, address, coords:{lat,lng}, type, typeName, ownerAsiakasId, ownerName, jerryActiveUntil }> (+truncated:true when the result hit the limit)",
    errors: [
      { origin: "client", exit: 4, meaning: "--asiakas is not a positive integer", remedy: "pass a numeric asiakasId (see ownerAsiakasId in the output, or resolve the company via `ib search <name>`)" },
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "Synonyms: plant = factory = tehdas = (betoni)asema — Finnish users say tehdas or asema for the same thing, so 'Mitkä autot kävi Kivikon asemalla?' means the Kivikko betoniasema (resolve it here, then `ib vehicle visits sijainti <id>`).",
      "Needs a backend deployed ≥ 2026-06-11 (scope=all + the ownerAsiakasId field); on an older backend the result silently falls back to the own+shared scope and --asiakas matches nothing.",
      "The plant type is resolved by NAME (betoniasema) through the sijaintiTypes lookup, not a hardcoded id.",
      "`truncated:true` flags a capped result — same semantics as `sijainti list`.",
    ],
    seeAlso: ["ib sijainti list", "ib sijainti types", "ib search", "ib vehicle visits"],
    examples: [
      "ib sijainti plants",
      "ib sijainti plants --asiakas 30",
      "ib sijainti plants --search kivikko",
      "ib sijainti tehtaat",
    ],
  },
  {
    command: "ib sijainti get",
    description: "Get a single sijainti by id.",
    permissions: ["auth.page.sijainnit.read"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to fetch" }],
    flags: [],
    outputShape:
      "{ sijaintiId, name, address, coords:{lat,lng}, type, jerryActiveUntil, ... } (raw row)",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    examples: ["ib sijainti get 42"],
  },
  {
    command: "ib sijainti dashboard",
    description:
      "One-shot Address Information Dashboard report for a sijainti (location) — merges weather, building, cadastral parcel, nearby traffic cameras, nearby sijainnit, worksite deliveries, and nearby vehicles into a single JSON, with each section independently degrading to forbidden/error instead of failing the whole report. Resolve the point from EXACTLY ONE of the positional sijaintiId or --address.",
    auth: "any",
    args: [
      {
        name: "sijaintiId",
        type: "number",
        required: false,
        description: "sijaintiId to report on (mutually exclusive with --address)",
      },
    ],
    flags: [
      {
        name: "address",
        type: "string",
        description: "Street address to resolve the point from, instead of sijaintiId (mutually exclusive)",
      },
    ],
    outputShape:
      "{ point:{lat,lng}|null, address:string|null, weather, building, parcel, cameras, sijainti, deliveries, vehicles } — each section is { status:'ok'|'empty'|'forbidden'|'error', data?, error? }; a forbidden/error section never fails the whole command",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing or ambiguous point input", remedy: "pass exactly one of <sijaintiId> or --address" },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Per-section gating mirrors the FE dashboard: weather/cameras/vehicles degrade to forbidden when the company module is off; building/parcel are open to any authenticated user; a bad address or unresolvable point degrades EVERY section to error instead of failing the command.",
      "The `sijainti` section reports sijainnit found NEARBY the resolved point (~2 km) — unrelated to the sijaintiId positional used to resolve the point itself.",
      "`deliveries` reports worksite (tyomaa) delivery volume near the point; `vehicles` reports nearby BetoniJerry ecofleet vehicles.",
    ],
    seeAlso: ["ib worksite dashboard", "ib opendata building", "ib opendata parcel", "ib sijainti list"],
    examples: [
      "ib sijainti dashboard 42",
      'ib sijainti dashboard --address "Oraspolku 2, Helsinki"',
    ],
  },
  {
    command: "ib sijainti create",
    description:
      "Create a new sijainti (POST /api/geocode/sijainti/add). REQUIRED: --name (sijaintiNimi) and --type (sijaintiTypeId). The CLI auto-fills the other NOT NULL columns the add proc needs: --lyh defaults to --name (truncated to 50 chars), --max-distance is the general delivery radius in km (default 50; independent of BetoniJerry enrolment), and --asiakas to your active company. Coordinates (--lat/--lng or --geocode) are persisted via a follow-up updateLatLng call (the add proc binds no lat/lng) and echoed as { lat, lng, coordsPersisted } so geocoding is verifiable without a re-read. Provide typed flags or --body JSON; typed flags win over --body.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      { name: "body", type: "json", description: "JSON object with the new sijainti fields (optional if typed flags given) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "name", type: "string", description: "sijaintiNimi (REQUIRED)" },
      { name: "address", type: "string", description: "sijaintiOsoite1 (street)" },
      { name: "type", type: "number", description: "sijaintiTypeId (REQUIRED; see `ib sijainti types`)" },
      { name: "lat", type: "number", description: "Latitude (persisted via updateLatLng + echoed)" },
      { name: "lng", type: "number", description: "Longitude (persisted via updateLatLng + echoed)" },
      { name: "lyh", type: "string", description: "sijaintiLyh — short code/abbreviation, ≤50 chars (defaults to --name)" },
      { name: "max-distance", type: "number", description: "Delivery radius in km, stored as maxDeliveryDistance (default 50; not Jerry-only)" },
      { name: "asiakas", type: "number", description: "Owner asiakasId (defaults to your active company)" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) — STORED ONLY, not used for matching (fb#415): no pump has a boom minimum, so a floor could only hide you from work you can do" },
      { name: "puomi-max", type: "number", description: "puomiMax — largest boom (m) served from this sijainti (BetoniJerry matching; empty = unbounded)" },
      { name: "public", type: "boolean", description: "Create the row PUBLISHED (isPublic=1, readable cross-tenant). Omit for private — the default; requires company-admin rights" },
      { name: "geocode", type: "boolean", description: "Resolve lat/lng from the address via Google Maps when coordinates are not given (then persisted + echoed)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ sijaintiId, success, lat?, lng?, coordsPersisted? } — lat/lng/coordsPersisted present when coordinates were given (coordsPersisted:false on --dry-run)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      apiErr(400, 'Address could not be geocoded (--geocode, status ZERO_RESULTS)', "supply a fuller --address or pass --lat/--lng directly"),
      { origin: "client", exit: 4, meaning: "--puomi-min/--puomi-max not a non-negative number (e.g. a typo Commander coerced to NaN) or min > max", remedy: "pass metres 0–999.99 with min ≤ max" },
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "A new sijainti is created PRIVATE unless you pass --public. That is deliberate — no caller should be able to publish a location by omission — but for a BETONIASEMA (--type 1) it is rarely what you want: a private plant never appears in any customer's tehdas picker, and the keikka editor then auto-selects a farther plant and reports success. Nothing errors. Pass --public when creating a plant customers must be able to choose, or publish it afterwards with `ib sijainti set-public <id> --on`.",
      "--public requires company-admin rights (or sysadmin/developer) and is refused with 403 on --dry-run too; every other field on create is open to the edit tier. Creating the row private and having an admin publish it is the workaround.",
      "Before 2026-08-14 visibility was a property of the location TYPE, so `--type 1` alone produced a publicly visible plant. It no longer does — the flag is per row.",
    ],
    examples: [
      'ib sijainti create --name "Depot A" --type 5',
      'ib sijainti create --name "Kivikko" --type 1 --public --reason "plant customers must be able to pick"',
      'ib sijainti create --name "Depot A" --address "Industrial St 1, Helsinki" --type 1 --geocode',
      'ib sijainti create --name "Depot A" --address "Industrial St 1" --type 1 --lat 60.17 --lng 24.94 --lyh "DEP-A" --max-distance 80',
      "ib sijainti create --body '{\"sijaintiNimi\":\"Depot A\",\"sijaintiTypeId\":1}'",
    ],
  },
  {
    command: "ib sijainti update",
    description:
      "Update a sijainti via read-merge-write (GET current row + POST /api/geocode/updateSijainti). sijaintiId via --id or in --body. Omitted fields KEEP their current values (the save proc assigns directly — a sparse body would NULL e.g. jerryActiveUntil, dates, phone); pass an explicit null in --body to clear a field. --max-distance is the general delivery radius in km (stored as maxDeliveryDistance), independent of BetoniJerry enrolment. An address change re-geocodes the new address automatically when no --lat/--lng are given (soft-fail: geocodeFailed echoed; --geocode forces re-resolution and fails fast). --lat/--lng are persisted via a follow-up updateLatLng call (the save proc itself binds no lat/lng) and echoed as { lat, lng, coordsPersisted }. Provide typed flags or --body JSON; typed flags win over --body.",
    permissions: ["auth.page.sijainnit.edit"],
    flags: [
      { name: "body", type: "json", description: "JSON object with fields to update (optional if typed flags given) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "id", type: "number", description: "Target sijaintiId (or include sijaintiId in --body)" },
      { name: "name", type: "string", description: "sijaintiNimi" },
      { name: "address", type: "string", description: "sijaintiOsoite1 (street)" },
      { name: "type", type: "number", description: "sijaintiTypeId" },
      { name: "lat", type: "number", description: "Latitude (persisted via updateLatLng + echoed)" },
      { name: "lng", type: "number", description: "Longitude (persisted via updateLatLng + echoed)" },
      { name: "lyh", type: "string", description: "sijaintiLyh — short code/abbreviation (≤50 chars)" },
      { name: "max-distance", type: "number", description: "Delivery radius in km, stored as maxDeliveryDistance (not Jerry-only)" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) — STORED ONLY, not used for matching (fb#415): no pump has a boom minimum, so a floor could only hide you from work you can do" },
      { name: "puomi-max", type: "number", description: "puomiMax — largest boom (m) served from this sijainti (BetoniJerry matching; empty = unbounded)" },
      { name: "public", type: "boolean", description: "Publish (isPublic=1, readable cross-tenant). Requires company-admin rights; omit BOTH flags to leave visibility untouched" },
      { name: "private", type: "boolean", description: "Unpublish (isPublic=0, owning tenant only). Mutually exclusive with --public; see `ib sijainti set-public`" },
      { name: "geocode", type: "boolean", description: "Force re-resolving lat/lng from the address via Google Maps (fails fast on no match). Address changes auto-geocode even without this flag when no coordinates are given" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, ..., lat?, lng?, coordsPersisted?, geocodeFailed? } — lat/lng/coordsPersisted present when coordinates were supplied or geocoded; geocodeFailed when the automatic address-change geocode found no match (update still ran, coords now NULL)",
    errors: [
      apiErr(400, "Validation failed", "fix --body fields"),
      apiErr(400, 'Address could not be geocoded (--geocode, status ZERO_RESULTS)', "supply a fuller --address or pass --lat/--lng directly"),
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      { origin: "client", exit: 4, match: ["non-negative number of metres", "cannot exceed"], meaning: "--puomi-min/--puomi-max not a non-negative number (e.g. a typo Commander coerced to NaN) or min > max — would otherwise clear the stored bound", remedy: "pass metres 0–999.99 with min ≤ max" },
      { origin: "client", exit: 4, match: "at most one of --public", meaning: "Both --public and --private given", remedy: "pass at most one — omit both to leave visibility untouched" },
      apiErr(403, "Not a company admin — only admins may CHANGE isPublic", "drop --public/--private to edit the other fields, or ask a company admin; see `ib sijainti set-public`"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: [
      'ib sijainti update --id 42 --name "Renamed depot"',
      'ib sijainti update --id 42 --address "Teollisuuskatu 9, Helsinki" --geocode',
      "ib sijainti update --body '{\"sijaintiId\":42,\"sijaintiNimi\":\"Renamed depot\"}'",
      "ib sijainti update --id 42 --public --reason 'open this plant to customers'",
    ],
  },
  {
    command: "ib sijainti set-jerry",
    description: "Enrol or unenrol a varikko (location) in BetoniJerry by setting sijainti.jerryActiveUntil (POST /api/geocode/updateSijainti).",
    permissions: ["auth.page.sijainnit.edit"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to toggle" }],
    flags: [
      { name: "on", type: "boolean", description: "Enrol (jerryActiveUntil = sentinel) + ensure a delivery radius" },
      { name: "off", type: "boolean", description: "Unenrol (jerryActiveUntil = null)" },
      { name: "radius", type: "number", description: "Delivery radius in km (maxDeliveryDistance) to set when enrolling; defaults to 50 when the varikko has none" },
      { name: "puomi-min", type: "number", description: "puomiMin (m) to set while enrolling — STORED ONLY, not used for matching (fb#415); betonijerry matches on puomiMax alone" },
      { name: "puomi-max", type: "number", description: "puomiMax (m) to set while enrolling" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ ok: true, ... } (raw backend response) or { dryRun: true, wouldUpdate: {...} }",
    errors: [
      apiErr(400, "Neither/both of --on/--off given, or --radius not a positive number", "pass exactly one of --on / --off; --radius is km > 0"),
      { origin: "client", exit: 4, meaning: "--puomi-min/--puomi-max not a non-negative number or min > max", remedy: "pass metres 0–999.99 with min ≤ max" },
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "--on writes the permanent sentinel; --off clears it to null.",
      "IMPORTANT: BetoniJerry coverage keys on the delivery radius maxDeliveryDistance (KM) — NOT geofenceRadius (metres, a GPS depot detector) — so --on ALSO sets that radius: --radius <km>, or a 50 km default when the varikko has none (otherwise it would be enrolled but cover nothing).",
      "Replicates the EditSijainti toggle: reads the row, overrides the fields, and writes back (lat/lng etc. preserved).",
      "Matching also requires the company-level gates: isPumppuToimittaja AND the HAS_JERRY setting (asiakasSettingTypeId 35) — toggle both with `ib jerry admin enable`. Varikko enrolment alone does not make the company matchable.",
      "Boom matching (since 2026-07, corrected 2026-08-12): a request stating a boom matches a varikko when its REACH covers it — puomiMax IS NULL (unbounded) OR puomiMax >= boom. `puomiMin` is stored but NOT matched on: any pump can be run as a line pump with no boom, so a floor could only hide a provider from work it can do (fb#415). Vehicle fleet booms are NOT consulted. Deploy-gated: needs the backend with sijainti puomi columns.",
    ],
    examples: [
      "ib sijainti set-jerry 42 --on --radius 60 --reason 'pilot varikko, 60 km radius'",
      "ib sijainti set-jerry 42 --on --reason 'enrol with default 50 km radius'",
      "ib sijainti set-jerry 42 --off --reason 'seasonal pause'",
    ],
  },
  {
    command: "ib sijainti set-public",
    description:
      "Publish or unpublish a sijainti — set dbo.sijainti.isPublic (POST /api/geocode/updateSijainti). Publishing makes the row readable CROSS-TENANT by every authenticated user, which is how the keikka flow finds a supplier's concrete plants.",
    permissions: ["auth.page.sijainnit.edit", "company admin (to change isPublic)"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to publish/unpublish" }],
    flags: [
      { name: "on", type: "boolean", description: "Publish (isPublic = 1) — readable by every tenant" },
      { name: "off", type: "boolean", description: "Unpublish (isPublic = 0) — owning tenant only" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ ok: true, ... } (raw backend response) or { dryRun: true, wouldUpdate: {...} }",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither or both of --on/--off given", remedy: "pass exactly one — visibility is never inferred" },
      apiErr(403, "Not a company admin — only admins may change visibility", "the edit tier can change every other field; ask a company admin (or a developer) to flip this one"),
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    notes: [
      "isPublic = 1 means readable by every authenticated user of EVERY tenant, competitors included — it is a cross-tenant exposure control, not a display preference. `ib sijainti get` on a published row succeeds for any caller; on a private row it 403s unless you are entitled to the owner.",
      "PER-ROW since 2026-08-14. It used to live on the location TYPE, so a supplier's plants were all readable or none were; now a decommissioned or contract-only plant can be withheld while the rest stay listed.",
      "The 403 applies to --dry-run too: an authorization refusal must not be reported as a successful preview. Changing OTHER fields is unaffected — the gate is on this field, not on the route.",
      "Replicates the EditSijainti save: reads the row, overrides isPublic, writes back, so jerryActiveUntil / dates / phone / comment survive. Going through updateSijainti is also required for CACHE correctness — that route's invalidation sweep is what stops a list cached while the row was public from being served after it is made private.",
      "Unpublishing a concrete plant removes it from every customer's tehdas picker. That is silent by design on their side: the keikka editor simply auto-selects a different plant. Audit with `ib sijainti list --type betoniasema --all --private`.",
      "Flips are recorded to changeTracker as \"Julkinen sijainti\" (who/when/old→new), so --reason is worth passing even though it is not enforced.",
    ],
    seeAlso: ["ib sijainti list", "ib sijainti get", "ib sijainti update", "ib sijainti set-jerry"],
    examples: [
      "ib sijainti set-public 42 --on --reason 'plant open to customers'",
      "ib sijainti set-public 42 --off --reason 'decommissioned, hide from pickers'",
      "ib sijainti set-public 42 --on --dry-run",
    ],
  },
  {
    command: "ib sijainti delete",
    description:
      "Soft-delete a sijainti (sets deletedTime). Requires --reason; --dry-run available.",
    permissions: ["auth.page.sijainnit.delete"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to soft-delete" }],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true }",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.delete"),
    ],
    examples: ['ib sijainti delete 42 --reason "decommissioned depot"'],
  },
  {
    command: "ib sijainti undelete",
    description: "Restore a soft-deleted sijainti. Requires --reason.",
    permissions: ["auth.page.sijainnit.edit"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId to restore" }],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true }",
    errors: [
      apiErr(404, "Sijainti not found", "verify sijaintiId"),
      ...permErrors("auth.page.sijainnit.edit"),
    ],
    examples: ['ib sijainti undelete 42 --reason "restored after review"'],
  },
  {
    command: "ib sijainti types",
    description:
      "List sijainti type categories (the 'Sijainnin laji' lookup). Resolves the sijaintiTypeId values used by `sijainti list --type` (which also accepts these names, e.g. betoniasema) and `create/update --type`.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "jerry", type: "boolean", description: "Return ONLY the BetoniJerry-eligible types (useJerry=1). Since fb#608 every row carries `useJerry`, so the unfiltered call already answers which types are eligible — this flag is now a convenience, not the only way to find out." },
    ],
    outputShape: "ListEnvelope<{ sijaintiTypeId, selite, useJerry }> — `useJerry` is the column --jerry filters on (fb#608); before it was surfaced, learning the eligible set meant running the command twice and diffing the id sets. NOTE: sijaintitypes.isPublic is deliberately NOT reported — cross-tenant visibility is per ROW (dbo.sijainti.isPublic), not per type, so a type-level flag cannot answer 'is this location public'.",
    errors: permErrors("auth.page.sijainnit.read"),
    examples: ["ib sijainti types", "ib sijainti types --jerry"],
  },
  {
    command: "ib sijainti geocode",
    description:
      "Geocode a free-form address to coordinates via Google Maps. Useful before `sijainti create` to obtain lat/lng. ownerAsiakasId is derived from the token.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "address", type: "string", description: "Free-form address (REQUIRED)" },
    ],
    outputShape:
      "{ geocoded:boolean, lat|null, lng|null, placeId|null, formattedAddress|null, status, results[] }",
    errors: permErrors("auth.page.sijainnit.read"),
    notes: [
      "The flat fields are the SAME shape `ib jerry check-address` returns (geocoded/lat/lng/placeId/formattedAddress), so one parser reads both. The raw Google payload is retained as `results[]` for callers that need address_components, viewport, or location_type.",
      "No match is `geocoded:false` with exit 0, not an error — the address not existing is an answer. Always read `status` alongside it: ZERO_RESULTS means Google found nothing (or the address was shorter than 5 characters), while TEST_ADDRESS / GOOGLE_MAPS_TIMEOUT / GOOGLE_MAPS_API_ERROR mean the lookup never happened. Treating a bare geocoded:false as 'no such address' hides a service failure.",
    ],
    seeAlso: ["ib jerry check-address"],
    examples: ['ib sijainti geocode --address "Mannerheimintie 1, Helsinki"'],
  },
  {
    command: "ib sijainti closest",
    description:
      "Find the closest sijainti of a given sijaintiTypeId to a worksite (tyomaa), by straight-line distance. asiakasId defaults to the active company.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED unless --tyomaa; same flag as the rest of the CLI)" },
      { name: "tyomaa", type: "number", description: "Target tyomaaId (Finnish alias of --worksite)" },
      { name: "type", type: "number", description: "sijaintiTypeId to search within (REQUIRED)" },
      { name: "asiakas", type: "number", description: "Owner asiakasId (defaults to active company)" },
    ],
    outputShape: "{ closestSijainti: {...}|null, closestDistance: number|null }",
    errors: [
      {
        origin: "client",
        exit: 4,
        meaning:
          "No worksite given, --worksite and --tyomaa differ, or one of --worksite/--tyomaa/--type/--asiakas is not a positive integer",
        remedy: "name the worksite once (--worksite OR --tyomaa) and pass integer ids",
      },
      apiErr(400, "Invalid tyomaaId or missing coordinates", "verify the worksite has lat/lng"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    notes: [
      "No sijainti of the type → both fields null (the backend's 999999999 no-result sentinel distance is normalized to null).",
    ],
    examples: ["ib sijainti closest --worksite 555 --type 1", "ib sijainti closest --tyomaa 555 --type 1"],
  },
  {
    command: "ib sijainti distance",
    description:
      "Driving distance and time between two points (Google Maps). Each endpoint is either 'lat,lng' or a sijaintiId (resolved to its coordinates). ownerAsiakasId is derived from the active company.",
    permissions: ["auth.page.sijainnit.read"],
    flags: [
      { name: "from", type: "string", description: "Origin: 'lat,lng' or a sijaintiId (REQUIRED)" },
      { name: "to", type: "string", description: "Destination: 'lat,lng' or a sijaintiId (REQUIRED)" },
    ],
    outputShape: "{ matkaM: number|null, matkaMin: number|null, from:{lat,lng}, to:{lat,lng} }",
    errors: [
      apiErr(400, "Bad point or sijainti without coordinates", "use 'lat,lng' or a sijaintiId that has coords"),
      ...permErrors("auth.page.sijainnit.read"),
    ],
    examples: [
      "ib sijainti distance --from 7 --to 42",
      'ib sijainti distance --from "60.17,24.94" --to 42',
    ],
  },

  // ─── ohje (4) — UI help-text content (helps table behind HelperIcon) ──────
  {
    command: "ib ohje get",
    description:
      "Get one UI help-text entry by helpId — the title/shorttext/htmltext shown in a HelperIcon '(?)' modal in the web UI. This is end-user help CONTENT, distinct from `ib --help` (CLI usage). Returns null when the helpId has no entry yet. The HTTP route is unauthenticated, but ib calls it with your session token (login still required).",
    auth: "any",
    args: [{ name: "helpId", type: "string", description: "the helpId (e.g. LaskupohjaTilaus)" }],
    flags: [],
    outputShape: "{ helpId, title, shorttext, htmltext, img } | null",
    errors: [
      { origin: "client", exit: 4, meaning: "Invalid helpId", remedy: "helpId must be 1–250 characters" },
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib ohje get LaskupohjaTilaus", "ib ohje get LaskupohjaTilaus --pretty"],
  },
  {
    command: "ib ohje list",
    description:
      "List every UI help-text entry (the whole helps table). Useful to discover helpIds before `ib ohje get`/`update`. The full table is LARGE (~115 KB — every row's htmltext), so AI callers should shape it CLIENT-SIDE: --empty-shorttext (grooming backfill targets), --fields (column projection that drops the big htmltext), --sort field:dir. Order applied: filter → sort → limit → project. The HTTP route is unauthenticated, but ib calls it with your session token.",
    auth: "any",
    flags: [
      { name: "limit", type: "number", description: "Max rows to return (client-side cap, after filter+sort)" },
      { name: "search", type: "string", description: "Case-insensitive substring over helpId + title + shorttext — the reflex filter every other list command has (fb#607). Applied CLIENT-SIDE like the rest, and BEFORE --limit, so a search plus a limit returns the first N MATCHES rather than searching the first N rows. htmltext is deliberately not searched: a body-text hit would return a row without showing why it matched." },
      { name: "empty-shorttext", type: "boolean", description: "Only rows whose shorttext is blank (grooming backfill targets)" },
      { name: "fields", type: "string", description: "Comma-separated columns to keep, e.g. helpId,title,shorttext,accessCount (drops the large htmltext)" },
      { name: "sort", type: "string", description: "Sort by a column, e.g. accessCount:desc (numeric fields compare numerically)" },
      { name: "needs-review", type: "boolean", description: "Only help rows still needing grooming: aiConfidence below the threshold (or unassessed) AND not parked, oldest-first by lastModifiedTime." },
      { name: "max-confidence", type: "number", description: "Threshold for --needs-review (default 90)." },
    ],
    outputShape: "ListEnvelope<{ helpId, title, shorttext, htmltext, img, accessCount, aiConfidence, needsHumanReview, … }> (rows projected to --fields when set)",
    errors: [apiErr(500, "Backend error", "retry with --verbose")],
    examples: [
      "ib ohje list --limit 10 --pretty",
      "ib ohje list --empty-shorttext --fields helpId,title,accessCount --sort accessCount:desc",
      "ib ohje list --needs-review --fields helpId,title,aiConfidence,shorttext",
    ],
  },
  {
    command: "ib ohje update",
    description:
      "Update a UI help-text entry (PUT /api/helps/update). The CLI GET-merges the current row first, so fields you omit are PRESERVED (helps_save overwrites the whole row). Provide typed flags or --body JSON; typed flags win. --reason is required for a write. Mirrors the HelperIcon in-place editor.",
    permissions: ["isHelperEditor (or system-admin/developer)"],
    args: [{ name: "helpId", type: "string", description: "the helpId to update (created if it does not exist)" }],
    flags: [
      {
        name: "body",
        type: "json",
        description: "JSON with any of title/shorttext/htmltext/img (typed flags win)",
      },
      { name: "title", type: "string", description: "Help title (otsikko)" },
      { name: "shorttext", type: "string", description: "Short text" },
      { name: "htmltext", type: "string", description: "Modal body — rendered as MARKDOWN (react-markdown + GFM), NOT HTML despite the column name. Use markdown (**bold**, - bullets, blank line = paragraph); raw <p>/<ul> tags show literally." },
      { name: "img", type: "string", description: "Image reference (" + clearHint("--img") + ", to null)" },
      { name: "must-exist", type: "boolean", description: "Fail (exit 4) instead of creating a new row when the helpId has no entry — guards against a typo'd helpId silently spawning a junk row" },
      { name: "ai-confidence", type: "number", description: "Self-assessed completeness/correctness 0–100 (groom rubric). Omit on a human edit to reset the score and re-open the row." },
      { name: "needs-human-review", type: "boolean", description: "Park the help row for a human (excludes it from --needs-review); set with a low --ai-confidence when blocked." },
      { name: "field", type: "string", description: "Edit-mode target field: title | shorttext | htmltext (default htmltext)" },
      { name: "replace", type: "string", description: "Edit mode: replace this literal text in the target field (exactly once unless --all)" },
      { name: "with", type: "string", description: 'Replacement for --replace (empty deletes the matched text; ' + clearHint("--with") + ")" },
      { name: "append", type: "string", description: "Edit mode: append text to the target field (verbatim)" },
      { name: "prepend", type: "string", description: "Edit mode: prepend text to the target field (verbatim)" },
      { name: "all", type: "boolean", description: "With --replace: substitute every occurrence" },
    ],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape:
      "{ success: true, helpId, created, written: {helpId,title,shorttext,htmltext,img, aiConfidence?, needsHumanReview?}, htmltextLength, response } — `created` is true when no prior row existed (a parallel groomer can spot an unexpected insert); aiConfidence/needsHumanReview present in `written` only when those flags were passed; or { dryRun: true, helpId, created, current, proposed } | edit dry-run: {dryRun:true, helpId, field, matchCount?, addedLines, removedLines, sameContent, unified}",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / invalid helpId / --must-exist on a missing row", remedy: "pass --reason; helpId 1–250 chars; drop --must-exist to create" },
      { origin: "client", exit: 5, meaning: "helpId has no existing row (edit mode only)", remedy: "create the entry first with a full --htmltext/--title/--shorttext" },
      apiErr(400, "Validation failed", "title ≤500, htmltext ≤10000, helpId 1–250 chars"),
      apiErr(403, "Permission denied", "needs isHelperEditor or system-admin/developer"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      'ib ohje update LaskupohjaTilaus --title "Laskupohja" --htmltext "<p>Ohje…</p>" --reason "content fix"',
      'ib ohje update LaskupohjaTilaus --dry-run --title "New title"',
      'ib ohje update "käyttöikä" --shorttext "Betonin käyttöikä" --must-exist --reason groom',
      'ib ohje update tila:2 --append "<p>Lisätieto…</p>" --reason "expand help" --dry-run',
    ],
  },
  {
    command: "ib ohje delete",
    description:
      "Delete a UI help-text entry (DELETE /api/helps/delete/:helpId). Removes orphan (stale-named) or empty data-driven helpIds — a missing help row just makes its HelperIcon render nothing (graceful absence), so deleting an empty/unused row is safe. --reason is required for a write. --dry-run previews the row that WOULD be deleted CLIENT-SIDE without issuing the DELETE (works before the backend route deploys). Idempotent: a missing row returns deleted:false. Requires isHelperEditor or system-admin/developer.",
    permissions: ["isHelperEditor (or system-admin/developer)"],
    args: [{ name: "helpId", type: "string", description: "the helpId to delete" }],
    flags: [],
    writeFlags: true,
    reasonPolicy: "unless-dry-run",
    dryRunKind: "client",
    outputShape:
      "{ success: true, helpId, deleted: boolean } — deleted is false when no row existed (idempotent); or { dryRun: true, helpId, wouldDelete: {helpId,title,shorttext,htmltext,img}|null } with --dry-run",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / invalid helpId", remedy: "pass --reason; helpId 1–250 chars" },
      apiErr(403, "Permission denied", "needs isHelperEditor or system-admin/developer"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Backend route is deploy-gated: DELETE /api/helps/delete/:helpId 404s until puminet5api ships it. --dry-run works immediately (resolved client-side via a GET).",
    ],
    examples: [
      'ib ohje delete sendIlmoitusButton --reason "orphan: button renamed to sendNotificationsButton"',
      "ib ohje delete koekappale --dry-run",
    ],
  },

  // ─── legal (15) — versioned legal documents + acceptance tracking ─────────
  {
    command: "ib legal types",
    description:
      "List legal document types (EULA, TOS, PRIVACY, BETONIJERRY_TOS, ...) with their personSettingTypeId acceptance mapping. A NULL personSettingTypeId means acceptances for that type cannot be tracked.",
    auth: "any",
    flags: [],
    outputShape:
      "ListEnvelope<{documentTypeId, typeName, displayName, description, sortOrder, personSettingTypeId}>",
    errors: COMMON_AUTH_ERRORS,
    seeAlso: ["ib legal show", "ib legal status"],
    examples: ["ib legal types"],
  },
  {
    command: "ib legal show",
    description:
      "Fetch the current ACTIVE document of a type, including markdown content. typeName uniquely implies the tenant (BETONIJERRY_TOS vs TOS) — no owner flag needed. --meta omits the (potentially >10 KB) content.",
    auth: "any",
    args: [{ name: "typeName", type: "string", description: "Document type name (see ib legal types)" }],
    flags: [
      { name: "meta", type: "boolean", description: "Omit markdownContent (returns contentLength instead)" },
      {
        name: "language",
        type: "string",
        default: "fi",
        description: "Document language: fi (binding original) or en (unofficial translation). The backend falls back to the fi row when no active en row exists for the type.",
        allowed: ["fi", "en"],
      },
    ],
    outputShape:
      "{documentId, typeName, version, title, effectiveDate, markdownContent | contentLength, ...}",
    notes: [
      "The document body is the `markdownContent` field — NOT `content` or `body` (with --meta it is omitted and only `contentLength` is returned). `ib legal get` uses the same field name.",
    ],
    errors: [
      apiErr(404, "No active document of this type", "check ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal types", "ib legal versions"],
    examples: ["ib legal show BETONIJERRY_TOS", "ib legal show TOS --meta", "ib legal show TOS --language en"],
  },
  {
    command: "ib legal active",
    aliases: ["ib legal list"],
    description:
      "Roll-up of the current ACTIVE document of EVERY type in one call — the single-view answer to 'what legal text is live right now'. One row per type: types with no active version appear with hasActive:false (not dropped). Content is stripped (contentLength only) — read a body via ib legal show <typeName>. Client-side fan-out over ib legal types + ib legal show.",
    auth: "any",
    flags: [
      {
        name: "language",
        type: "string",
        default: "fi",
        description: "Document language applied to every per-type fetch: fi (binding original) or en (unofficial translation, falls back to fi where no active en row exists).",
        allowed: ["fi", "en"],
      },
    ],
    outputShape:
      "ListEnvelope<{typeName, displayName, personSettingTypeId, hasActive, documentId, version, title, effectiveDate, contentLength}>",
    errors: COMMON_AUTH_ERRORS,
    notes: ["Also reachable as `ib legal list` (alias) — `active` is the legal group's analog of other domains' `list`."],
    seeAlso: ["ib legal types", "ib legal show"],
    examples: ["ib legal active", "ib legal list", "ib legal active --language en"],
  },
  {
    command: "ib legal status",
    description:
      "Which legal documents you have accepted (version + timestamp) and which are still missing. Defaults to yourself and your token's company scope. --person requires developer/sysadmin (server-enforced). Content is stripped — read it via ib legal show. Entries under `missing` are active documents not yet accepted; an empty result means the scope has no active documents.",
    auth: "any",
    flags: [
      { name: "person", type: "number", description: "Check another personId (developer/sysadmin only)" },
      { name: "owner", type: "number", description: "ownerAsiakasId scope (default: your company from the token)" },
    ],
    outputShape:
      "{personId, ownerAsiakasId, requiresAcceptance, accepted: [{typeName, acceptedVersion, acceptedDate, ...}], missing: [...]}",
    errors: [
      apiErr(403, "--person on someone else without developer/sysadmin", "drop --person or use a developer token"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal show", "ib legal acceptances"],
    examples: ["ib legal status", "ib legal status --person 6233"],
  },
  {
    command: "ib legal versions",
    description:
      "All versions of a document type, newest first. Every row carries a lifecycle status: draft (saved, never published) | active (live now, also isActive=1) | archived (superseded former-active) | deleted (soft-deleted). Soft-deleted versions are EXCLUDED by default — pass --deleted (or --status deleted) to see them. Use --status to filter. Content stripped; fetch one version with ib legal get, or compare two with ib legal diff.",
    auth: "any",
    args: [{ name: "typeName", type: "string", description: "Document type name (see ib legal types)" }],
    flags: [
      { name: "owner", type: "number", description: "Filter by ownerAsiakasId tenant scope" },
      { name: "status", type: "string", description: "Filter by lifecycle status: draft|active|archived|deleted", allowed: ["draft", "active", "archived", "deleted"] },
      {
        name: "deleted",
        type: "boolean",
        description:
          "Include soft-deleted versions, which the default listing hides (fb#514). A deletion here keeps the row for audit rather than removing it, so discarded verification drafts would otherwise clutter a compliance-relevant listing forever. Same shape as `ib vehicle list --deleted`. An explicit --status overrides this flag (--status names exactly what you want, so `--status deleted` selects them and `--status active --deleted` is just --status active).",
      },
      {
        name: "language",
        type: "string",
        default: "fi",
        description: "Filter by document language: fi (binding original) or en (unofficial translation)",
        allowed: ["fi", "en"],
      },
    ],
    outputShape:
      "ListEnvelope<{documentId, version, title, status, isActive, effectiveDate, createdBy, createdTime, notes, ownerAsiakasId}>",
    errors: COMMON_AUTH_ERRORS,
    seeAlso: ["ib legal get", "ib legal diff", "ib legal drafts", "ib legal activate"],
    examples: ["ib legal versions TOS", "ib legal versions TOS --status draft", "ib legal versions BETONIJERRY_TOS", "ib legal versions TOS --language en"],
  },
  {
    command: "ib legal drafts",
    description:
      "Unpublished DRAFT versions across EVERY type — the cross-type answer to 'is anything staged to publish?' (the draft counterpart of ib legal active). One row per draft; content stripped (read a body via ib legal get, or compare with ib legal diff). Client-side fan-out over ib legal types + ib legal versions --status draft.",
    auth: "any",
    flags: [],
    outputShape:
      "ListEnvelope<{documentId, typeName, version, title, status, effectiveDate, createdBy, createdTime, notes, ownerAsiakasId}>",
    errors: COMMON_AUTH_ERRORS,
    seeAlso: ["ib legal active", "ib legal versions", "ib legal diff"],
    examples: ["ib legal drafts"],
  },
  {
    command: "ib legal get",
    description:
      "One document version by documentId — or by typeName (e.g. PRIVACY) to read that type's current ACTIVE version, so the typeName-keyed rows of ib legal list chain directly into get. The body is returned in the `markdownContent` field.",
    auth: "any",
    args: [
      {
        name: "documentIdOrType",
        type: "string",
        description: "legalDocuments.documentId, or a typeName (UPPER_SNAKE, see ib legal types) resolving to its active version",
      },
    ],
    flags: [],
    outputShape:
      "{documentId, documentTypeId, typeName, version, title, status, markdownContent, isActive, ...}",
    notes: [
      "The document body is the `markdownContent` field — NOT `content` or `body`. Reading `.content` returns undefined (an empty body) with no error: a silent false-negative. `ib legal show` uses the same field name.",
    ],
    errors: [
      { origin: "client", exit: 4, meaning: "Argument is neither a numeric documentId nor a typeName", remedy: "pass a documentId from ib legal list, or a typeName like PRIVACY" },
      apiErr(404, "Document not found / type has no active document", "list ids via ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal versions", "ib legal diff"],
    examples: ["ib legal get 12", "ib legal get PRIVACY"],
  },
  {
    command: "ib legal diff",
    description:
      "Line diff between two document versions WITHOUT pulling both full bodies into context. Two modes: pass two documentIds (<a> old, <b> new), or --type <name> to diff that type's newest DRAFT against its current ACTIVE version (i.e. what would change if you publish the draft). Returns per-side metadata + added/removed line counts + a compact unified diff (long unchanged runs collapse).",
    auth: "any",
    args: [
      { name: "a", type: "number", required: false, description: "Old documentId (omit when using --type)" },
      { name: "b", type: "number", required: false, description: "New documentId (omit when using --type)" },
    ],
    flags: [
      { name: "type", type: "string", description: "Diff newest DRAFT vs current ACTIVE of this type (instead of <a> <b>)" },
      { name: "owner", type: "number", description: "ownerAsiakasId scope for --type resolution (1349 = BetoniJerry); only valid with --type" },
    ],
    outputShape:
      "{a: {documentId, typeName, version, status, contentLength}, b: {...}, sameContent, addedLines, removedLines, unified}",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither two documentIds nor --type supplied (or both), or --owner without --type", remedy: "pass <a> <b> OR --type <name>" },
      apiErr(404, "documentId / type's draft or active not found", "check ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal versions", "ib legal drafts", "ib legal get"],
    examples: ["ib legal diff 4 38", "ib legal diff --type TOS", "ib legal diff --type BETONIJERRY_TOS --owner 1349"],
  },
  {
    command: "ib legal save",
    description:
      "Create a NEW document version (developer/sysadmin only). Versions are IMMUTABLE — any content/title change is a new version; there is no in-place edit. Saved as status='draft' (isActive=0) by default; --activate publishes atomically (status='active', archives the prior active version of the same type+tenant). Content from --file (local) or --content (inline; required over /api/cli/exec). --reason required unless --dry-run.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    flags: [
      { name: "type", type: "string", required: true, description: "Document type name (see ib legal types)" },
      { name: "doc-version", type: "string", required: true, description: "Version string, e.g. 2.0, max 20 chars — DB column nvarchar(20) (NOT --version — that is the global CLI version flag)" },
      { name: "title", type: "string", description: "Document title (required for a full save; defaults to the current doc's title in edit mode)" },
      {
        name: "language",
        type: "string",
        default: "fi",
        description: "Document language: fi (binding original) or en (unofficial translation). In edit mode (--replace/--append/--prepend) this also selects WHICH language's current active document is read.",
        allowed: ["fi", "en"],
      },
      { name: "file", type: "string", description: "Read markdown content from a local file" },
      { name: "content", type: "string", description: "Inline markdown content (use over /api/cli/exec — no local FS there)" },
      { name: "owner", type: "number", description: "ownerAsiakasId tenant scope (1349 = BetoniJerry); omit for global" },
      {
        name: "notes",
        type: "string",
        description:
          "Internal notes — what the ACTIVATOR reads at the moment of activation, so this is where the activation GATES belong: the deploy gate, whether to batch with other pending edits, an EN re-translation that must land with it, and the verification evidence. No length limit (widened 500 → nvarchar(MAX) on 2026-08-12); the old ceiling is what truncated a gate set and lost it (fb#453/fb#512).",
      },
      { name: "effective-date", type: "date", description: "Effective date YYYY-MM-DD (default: now)" },
      { name: "activate", type: "boolean", description: "Publish immediately (archives the prior active version). Default: inactive draft" },
      { name: "validate-json", type: "boolean", description: "Validate the embedded ```json block parses to an object before saving (recommended for BETONIJERRY_* structured types)" },
      { name: "replace", type: "string", description: "Edit mode: replace this literal text in the current ACTIVE version's markdown (must match exactly once unless --all)" },
      { name: "with", type: "string", description: "Replacement for --replace (empty deletes the matched text; " + clearHint("--with") + ")" },
      { name: "append", type: "string", description: "Edit mode: append text to the end of the current markdown (verbatim)" },
      { name: "prepend", type: "string", description: "Edit mode: prepend text to the start of the current markdown (verbatim)" },
      { name: "all", type: "boolean", description: "With --replace: substitute every occurrence instead of erroring on multiple matches" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "{documentId, success} | dry-run: {dryRun: true, wouldCreate: {...}, validation} | edit dry-run: {dryRun:true, type, field:\"markdownContent\", matchCount?, addedLines, removedLines, sameContent, unified}",
    errors: [
      {
        origin: "client", exit: 4,
        meaning: "Missing --reason / no content / --file unreadable or combined with --content / --validate-json failed",
        remedy: "pass --file OR --content, and --reason unless --dry-run",
        match: ["provide --file", "missing required flag", "mutually exclusive", "cannot read file", "--validate-json failed"],
      },
      {
        origin: "client", exit: 4,
        meaning: "Edit mode (--replace/--append/--prepend) resolved to a document in a DIFFERENT language than --language — Task 8's read falls back to the fi row when no active en row exists, so this refuses rather than silently publishing Finnish content tagged language:en",
        remedy: "create the target language version with a full --file/--content save first, then retry the edit",
        match: "edit would apply to the",
      },
      {
        origin: "client", exit: 4,
        meaning: "--doc-version exceeds 20 characters (DB column legalDocuments.version is nvarchar(20))",
        remedy: "shorten the version string to 20 characters or fewer",
        match: "limited to 20 characters",
      },
      // Two causes, one status. The truncation 400 is raised by SQL Server (in
      // Finnish, naming the column), so it can hit any nvarchar-bounded field —
      // `title` is nvarchar(200), and a 201-char title used to answer with the
      // required-fields remedy below even though every field WAS provided
      // (fb#485). Listed first for readability; the substring is what wins.
      apiErr(
        400,
        "A field exceeds its DB column length (SQL Server truncation error, names the column)",
        "shorten the field the message names — title is nvarchar(200), --doc-version nvarchar(20); --notes and content are unbounded",
        ["liian pitkä", "would be truncated", "string or binary data"]
      ),
      apiErr(400, "Required fields missing", "provide --type --doc-version --title and content"),
      ...LEGAL_DEV_ERRORS,
    ],
    notes: [
      "X-Dry-Run is honoured server-side on this route once the gating deploy is live — do not --dry-run against a backend without it (the write would persist).",
      "Edit mode (--replace/--append/--prepend) refuses when the served document's own language differs from --language (the fi fallback for a type with no active en document yet) — create the target language version with a full --file/--content save first.",
    ],
    seeAlso: ["ib legal activate", "ib legal versions"],
    examples: [
      'ib legal save --type TOS --doc-version 2.1 --title Kayttoehdot --file ./tos.md --reason "new clause 7"',
      'ib legal save --type TOS --doc-version 2.1 --title Kayttoehdot --content "# TOS" --activate --dry-run',
      "ib legal save --type BETONIJERRY_OFFER_ACCEPTANCE --doc-version offer-2026-06-18 --title 'Tarjouksen hyväksyntä' --file offer.md --validate-json --reason 'update CTA copy'",
      'ib legal save --type TOS --doc-version 2.1 --replace "14 vrk" --with "30 vrk" --reason "extend payment term" --dry-run',
      'ib legal save --type TOS --doc-version 2.1 --title "Terms of Service" --file ./tos-en.md --language en --activate --reason "publish EN translation"',
    ],
  },
  {
    command: "ib legal activate",
    description:
      "Publish a document version (developer/sysadmin only): atomically archives the current active version of the same type+tenant (status='archived') and activates this one (status='active', isActive=1; also stamps effectiveDate). Use to publish a draft or roll back to an earlier version.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    args: [{ name: "documentId", type: "number", description: "legalDocuments.documentId to activate" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "{success} | dry-run: {dryRun: true, wouldActivate: {documentId}, validation}",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason or invalid documentId", remedy: "pass --reason 'why' (not needed with --dry-run)" },
      ...LEGAL_DEV_ERRORS,
    ],
    seeAlso: ["ib legal save", "ib legal versions"],
    examples: ['ib legal activate 12 --reason "publish v2.1"'],
  },
  {
    command: "ib legal delete",
    description:
      "Soft-delete a document version (developer/sysadmin only): sets status='deleted' (isActive=0) so it is distinguishable from a draft or superseded version in ib legal versions. The row and all acceptance history remain in the database.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    args: [{ name: "documentId", type: "number", description: "legalDocuments.documentId to soft-delete" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "{success} | dry-run: {dryRun: true, wouldDelete: {documentId}, validation}",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason or invalid documentId", remedy: "pass --reason 'why' (not needed with --dry-run)" },
      ...LEGAL_DEV_ERRORS,
    ],
    seeAlso: ["ib legal versions"],
    examples: ['ib legal delete 12 --reason "superseded stub" --dry-run'],
  },
  {
    command: "ib legal acceptances",
    description:
      "Compliance report (developer/sysadmin only): WHO has accepted a document type — personId, name, email, accepted version + timestamp, newest first. Capped at 500 rows with a truncated flag. Types with NULL personSettingTypeId (e.g. GLOBAL today) are not trackable and return a validation error.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    args: [{ name: "typeName", type: "string", description: "Document type name (see ib legal types)" }],
    flags: [
      { name: "doc-version", type: "string", description: "Only acceptances of this version string (NOT --version — that is the global CLI version flag)" },
      { name: "limit", type: "number", default: "500", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{personId, firstName, lastName, email, acceptedVersion, acceptedAt}> & {typeName, personSettingTypeId, truncated?}",
    errors: [
      apiErr(400, "Type has no personSettingTypeId mapping", "fix the legalDocumentTypes row first"),
      apiErr(404, "Unknown document type", "ib legal types"),
      ...LEGAL_DEV_ERRORS,
    ],
    seeAlso: ["ib legal status", "ib legal types"],
    examples: ["ib legal acceptances BETONIJERRY_TOS", "ib legal acceptances TOS --doc-version 2.0"],
  },
  {
    command: "ib legal accept",
    description:
      "Record YOUR OWN acceptance of the current active version of a type. DEVELOPER TESTING AID, gated client-side to developer/sysadmin tokens — real consent is a human action recorded via the betoni.online / betonijerry.fi UI flows. The backend endpoint is self-only: you can never accept on someone else's behalf. --reason required unless --dry-run.",
    permissions: ["isSystemAdmin or isDeveloper (client-side gate)"],
    tier: "developer",
    args: [
      { name: "typeName", type: "string", required: false, description: "Document type name (see ib legal types; or pass --type)" },
    ],
    flags: [
      { name: "type", type: "string", description: "Document type name (alias for the positional)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "{success} | dry-run: {dryRun: true, wouldAccept: {...}, validation}",
    errors: [
      { origin: "client", exit: 3, meaning: "Not a developer/sysadmin token (client-side gate)", remedy: "use a developer account" },
      { origin: "client", exit: 4, meaning: "Missing typeName / missing --reason / type has no personSettingTypeId mapping", remedy: "pass <typeName> and --reason; check ib legal types" },
      apiErr(404, "No active document of this type", "ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Resolves the active version via two sequential reads (current + types); if another developer activates a new version between them, the recorded version string can be one step stale. Acceptable for a testing aid — verify with ib legal status afterwards.",
    ],
    seeAlso: ["ib legal status", "ib legal show"],
    examples: [
      'ib legal accept BETONIJERRY_TOS --reason "acceptance flow e2e test"',
      "ib legal accept TOS --dry-run",
    ],
  },
  {
    command: "ib legal type create",
    description:
      "Create a new legal document TYPE (developer/sysadmin only). Types are the catalogue rows behind ib legal types; document versions attach to a type via ib legal save. --setting-type-id wires acceptance tracking — the id must exist in personSettingTypes and not be mapped to another type. --reason required unless --dry-run.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    flags: [
      { name: "name", type: "string", required: true, description: "Type name, UPPER_SNAKE, max 50 (e.g. TOS_EN); immutable after creation" },
      { name: "display-name", type: "string", required: true, description: "Human-readable name (max 100)" },
      { name: "description", type: "string", description: "Short description (max 200)" },
      { name: "sort-order", type: "number", description: "List position (default 0)" },
      { name: "setting-type-id", type: "number", description: "personSettingTypeId for acceptance tracking (must exist and be unmapped)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "the created legalDocumentTypes row | dry-run: {dryRun: true, wouldCreateType: {...}, validation}",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / invalid or duplicate typeName / settingTypeId unknown or already mapped", remedy: "check ib legal types; pass --reason unless --dry-run" },
      ...LEGAL_DEV_ERRORS,
    ],
    notes: [
      "typeName is immutable after creation — choose carefully.",
      "Deploy-gated: 404 until the backend ships POST /api/legal-documents/types.",
    ],
    seeAlso: ["ib legal type update", "ib legal types", "ib legal save"],
    examples: [
      'ib legal type create --name TOS_EN --display-name "Terms of Service" --reason "publish EN docs"',
      "ib legal type create --name SLA_FI --display-name Palvelutasosopimus --setting-type-id 45 --dry-run",
    ],
  },
  {
    command: "ib legal type update",
    description:
      "Update a legal document TYPE's editable fields: displayName, description, sortOrder, personSettingTypeId (developer/sysadmin only). typeName itself is immutable; fields you do not pass are untouched. At least one field flag required. --reason required unless --dry-run.",
    permissions: ["isSystemAdmin or isDeveloper (server-enforced)"],
    tier: "developer",
    args: [{ name: "typeName", type: "string", description: "Document type name (see ib legal types)" }],
    flags: [
      { name: "display-name", type: "string", description: "Human-readable name (max 100)" },
      { name: "description", type: "string", description: "Short description (max 200)" },
      { name: "sort-order", type: "number", description: "List position" },
      { name: "setting-type-id", type: "number", description: "personSettingTypeId for acceptance tracking (must exist in personSettingTypes and not be mapped to another type)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    mutates: true,
    outputShape: "the updated legalDocumentTypes row | dry-run: {dryRun: true, wouldUpdateType: {typeName, fields}, validation}",
    errors: [
      { origin: "client", exit: 4, meaning: "Missing --reason / no field flags / settingTypeId unknown or already mapped to another type", remedy: "pass at least one field flag and --reason unless --dry-run" },
      apiErr(404, "Unknown document type", "ib legal types"),
      ...LEGAL_DEV_ERRORS,
    ],
    notes: [
      "Clearing a value to NULL is not supported.",
      "Deploy-gated: 404 until the backend ships PUT /api/legal-documents/types/:typeName.",
    ],
    seeAlso: ["ib legal type create", "ib legal types", "ib legal acceptances"],
    examples: [
      'ib legal type update GLOBAL --setting-type-id 44 --reason "fix NULL mapping (feedback #31)"',
      'ib legal type update TOS_EN --display-name "Terms of Service v2" --dry-run',
    ],
  },

  // ─── schedule (3) ────────────────────────────────────────────────────────
  {
    command: "ib schedule today",
    description:
      "List today's keikkas for the active company. Wrapper around `ib keikka list --from today --to today`.",
    permissions: ["auth.page.grid.tilaus.read"],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule today", "ib schedule today --pretty"],
  },
  {
    command: "ib schedule day",
    description: "List keikkas for a specific day.",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "date", type: "date", description: "date (YYYY-MM-DD or today/yesterday/tomorrow)" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule day 2026-06-01", "ib schedule day tomorrow"],
  },
  {
    command: "ib schedule week",
    description:
      "List keikkas for a 7-day window starting at the given date.",
    permissions: ["auth.page.grid.tilaus.read"],
    args: [{ name: "start", type: "date", description: "week start date (YYYY-MM-DD or today/yesterday/tomorrow)" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ keikkaId, pvm, asiakasId, tyomaaId, vehicleId, tila, m3, time }>",
    errors: permErrors("auth.page.grid.tilaus.read"),
    examples: ["ib schedule week 2026-06-01", "ib schedule week today"],
  },

  // ─── v1.0.1 additions: customer/worksite/person lifecycle (11) ──────────
  {
    command: "ib customer delete",
    description: "Delete a customer (asiakas). Requires --reason; --dry-run available.",
    permissions: ["auth.page.asiakas.edit"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to delete" }],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ deleted: number } or { dryRun: true, wouldDelete: number }",
    errors: [
      apiErr(404, "Customer not found", "verify asiakasId"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer delete 9001 --reason "lifecycle cleanup"'],
  },
  {
    command: "ib customer person add",
    description: "Attach a person to a customer (asiakasPerson). Requires --reason.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ added: { asiakasId, personId } } or { dryRun: true, wouldCreate: { asiakasId, personId, contactPersonTypeId } }",
    errors: [
      apiErr(400, "Company limit (26) reached", "remove an existing link first"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer person add --asiakas 26 --person 5351 --contact-type 1 --reason "onboard driver"'],
  },
  {
    command: "ib customer person remove",
    description: "Detach a person from a customer (asiakasPerson). Requires --reason.",
    permissions: ["auth.page.asiakas.edit"],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: { asiakasId, personId } } or { dryRun: true, wouldDelete: { asiakasId, personId } }",
    errors: [
      apiErr(404, "Link not found", "verify asiakasId+personId combination"),
      ...permErrors("auth.page.asiakas.edit"),
    ],
    examples: ['ib customer person remove --asiakas 26 --person 5351 --reason "offboard driver"'],
  },
  {
    command: "ib customer person list",
    description:
      "List persons attached to a customer. `--role` filters by role name; the per-row `roleTypeId` only echoes that filter (null when unfiltered — the base membership row), so it is NOT the person's role set. For the FULL per-company roles pass `--include-roles` (adds permissionRoles[]) or use `ib person role list`.",
    permissions: ["auth.page.asiakas.read"],
    args: [{ name: "asiakasId", type: "number", required: false, description: "asiakasId (or pass --asiakas, like person add/remove)" }],
    flags: [
      { name: "asiakas", type: "number", description: "Target asiakasId (alias for the positional; same flag as person add/remove)" },
      { name: "role", type: "string", description: "Filter by role name (e.g. keikkaHandler)" },
      { name: "include-roles", type: "boolean", description: "Add permissionRoles[] (full per-company role names) to each person — N extra GETs, opt-in" },
    ],
    outputShape: "ListEnvelope<{ personId, name, email, personFirstName, personLastName, personEmail, roleTypeId: number|null, permissionRoles?: string[] }>",
    errors: [
      apiErr(400, "Unknown role name", "see ROLE_TYPEID_BY_NAME in @ibetoni/constants"),
      ...permErrors("auth.page.asiakas.read"),
    ],
    notes: [
      "Rows carry BOTH vocabularies (fb#621): the short `name` (first+last joined) and `email`, plus the canonical `personFirstName`/`personLastName`/`personEmail` that `ib person get` uses. Projecting the sibling's spelling here used to yield blank cells with no error — silently-empty data that reads as 'these people have no name on file'.",
    ],
    seeAlso: ["ib person role list", "ib person get"],
    examples: ["ib customer person list 26", "ib customer person list --asiakas 26 --role keikkaHandler", "ib customer person list 27 --include-roles"],
  },
  {
    command: "ib worksite delete",
    description: "Delete a worksite (tyomaa). Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId to delete" }],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ deleted: number } or { dryRun: true, wouldDelete: { tyomaaId } }",
    errors: [
      apiErr(404, "Worksite not found", "verify tyomaaId"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ['ib worksite delete 99 --reason "lifecycle cleanup"'],
  },
  {
    command: "ib worksite refresh-location",
    description: "Re-geocode a worksite from Google Maps (POST /api/tyomaa/refreshLocation/:id).",
    permissions: ["auth.page.tyomaa.edit"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success: true, tyomaa, message } (raw backend response)",
    errors: [
      apiErr(404, "Worksite not found", "verify tyomaaId"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ['ib worksite refresh-location 99 --reason "address corrected"'],
  },
  {
    command: "ib worksite set-geofence",
    description: "Set a worksite geofence radius in metres (1-10000).",
    permissions: ["auth.page.tyomaa.edit"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [
      { name: "radius", type: "number", description: "Geofence radius in metres (1-10000)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success: true }",
    errors: [
      apiErr(400, "Radius out of range", "use 1-10000"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ["ib worksite set-geofence 99 --radius 300"],
  },
  {
    command: "ib worksite helsinki-fetch",
    description: "Refresh Helsinki building data for a worksite (POST /api/tyomaa/helsinki/fetch/:id).",
    permissions: ["auth.page.tyomaa.edit"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success, ... } (raw backend response)",
    errors: [
      apiErr(400, "Missing coordinates", "run refresh-location first"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ["ib worksite helsinki-fetch 99"],
  },
  {
    command: "ib worksite person add",
    description: "Attach a person to a worksite (tyomaaPerson). Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ added: { tyomaaId, personId } } or { dryRun: true, wouldCreate: { tyomaaId, personId, contactPersonTypeId } }",
    errors: permErrors("auth.page.tyomaa.edit"),
    examples: ['ib worksite person add --worksite 99 --person 5351 --reason "assign foreman"'],
  },
  {
    command: "ib worksite person remove",
    description: "Detach a person from a worksite. Requires --reason.",
    permissions: ["auth.page.tyomaa.edit"],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (REQUIRED)" },
      { name: "person", type: "number", description: "Target personId (REQUIRED)" },
      { name: "contact-type", type: "number", default: "1", description: "contactPersonTypeId — membership link type (1=pumppari [default], 2=order-email recipient, 3=manual, 5=auto-from-keikka)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: { tyomaaId, personId } } or { dryRun: true, wouldDelete: { tyomaaId, personId } }",
    errors: [
      apiErr(404, "Link not found", "verify tyomaaId+personId combination"),
      ...permErrors("auth.page.tyomaa.edit"),
    ],
    examples: ['ib worksite person remove --worksite 99 --person 5351 --reason "rotation"'],
  },
  {
    command: "ib worksite person list",
    description: "List persons attached to a worksite.",
    permissions: ["auth.page.tyomaa.read"],
    args: [{ name: "tyomaaId", type: "number", required: false, description: "tyomaaId (or pass --worksite, like person add/remove)" }],
    flags: [
      { name: "worksite", type: "number", description: "Target tyomaaId (alias for the positional; same flag as person add/remove)" },
    ],
    outputShape: "ListEnvelope<{ personId, name, email, contactType }>",
    errors: permErrors("auth.page.tyomaa.read"),
    examples: ["ib worksite person list 99", "ib worksite person list --worksite 99"],
  },
  {
    command: "ib person create",
    description:
      "Create a person. REQUIRED: --first, --last. --email is OPTIONAL (personEmail is nullable; phone-only contacts are fine and the email can be added later via `ib person update`). --asiakas defaults to your active company. Returns the created person record (clean {personId, ...}), NOT the raw SQL recordset. With --get-or-create a duplicate email returns the existing person (reused:true) when that person is visible to you (the email dedup is global, so an email owned by a company you can't access errors with guidance instead) — useful for idempotent bulk onboarding. NOTE: creating under a non-active owned company (--asiakas <other>) sets ownership but no membership, and the record is synthesized in the reply because the read-back is scoped to your active company. Use typed flags or --body JSON (typed flags win). Requires --reason. Use --global to create a GLOBAL, self-managing person (ownerAsiakasId=null) discoverable across companies; --global and --asiakas are mutually exclusive.",
    permissions: ["auth.page.person.edit"],
    flags: [
      { name: "first", type: "string", description: "personFirstName (REQUIRED)" },
      { name: "last", type: "string", description: "personLastName (REQUIRED)" },
      { name: "phone", type: "string", description: "personPhone" },
      { name: "email", type: "string", description: "personEmail (optional)" },
      { name: "memo", type: "string", description: "personMemo — free-text note/comment (optional)" },
      { name: "asiakas", type: "number", description: "Owner asiakasId (defaults to your active company)" },
      { name: "global", type: "boolean", description: "Create a global, owner-less person (ownerAsiakasId=null). Mutually exclusive with --asiakas." },
      { name: "get-or-create", type: "boolean", description: "On a duplicate email, return the existing person (reused:true) when visible to you; an email owned by a company you can't access errors with guidance" },
      { name: "body", type: "json", description: "Raw JSON body, merged under typed flags (optional) ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "from-json", type: "string", description: "Read the JSON body from a file (or - for stdin); shell-safe alternative to --body. Mutually exclusive with --body." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ personId, name, email, ... } (re-fetched) · with --get-or-create adds reused:boolean · dry-run: { dryRun: true, wouldCreate: ... }",
    errors: [
      apiErr(400, "Missing required field, or duplicate email without --get-or-create", "provide --first and --last (email is optional); add --get-or-create to reuse an existing visible person, or use a different email"),
      ...permErrors("auth.page.person.edit"),
    ],
    notes: [
      "On Windows PowerShell inline --body JSON often fails (the shell strips the inner double-quotes) — prefer typed flags, or pass --from-json <file|-> (a file, or - for stdin) to avoid shell quoting entirely.",
    ],
    examples: [
      'ib person create --first Matti --last Virtanen --phone "+358501234567" --reason "phone contact"',
      'ib person create --first Matti --last Virtanen --email m@x.com --get-or-create --reason "onboard"',
      'ib person create --body \'{"personFirstName":"Matti","personLastName":"M"}\' --reason "onboard"',
      'ib person create --from-json ./person.json --reason "onboard"',
      'ib person create --first Matti --last Virtanen --global --reason "global self-managing person"',
    ],
  },
  {
    command: "ib person update",
    description:
      "Update a person. Set fields with typed flags (--first/--last/--phone/--email/--memo) and/or a --body/--from-json JSON patch (typed flags win); at least one field is required. Omitted fields are PRESERVED (the backend read-merges the stored row); pass an empty string to CLEAR a field (e.g. --email \"\"). " + clearNote("--email") + " Owner changes are separate — use `ib person owner`. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    args: [{ name: "personId", type: "number", description: "personId to update" }],
    flags: [
      { name: "first", type: "string", description: "personFirstName" },
      { name: "last", type: "string", description: "personLastName" },
      { name: "phone", type: "string", description: "personPhone" },
      { name: "email", type: "string", description: "personEmail (" + clearHint("--email") + ")" },
      { name: "memo", type: "string", description: "personMemo — free-text note/comment" },
      { name: "body", type: "json", description: "Patch body (JSON), merged UNDER the typed flags. Mutually exclusive with --from-json. ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "from-json", type: "string", description: "Read the patch body from a file (or - for stdin); shell-safe alternative to --body. Mutually exclusive with --body." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ ok: true, updated: { personId } } or { dryRun: true, wouldUpdate: { personId, ... } }",
    errors: [
      apiErr(400, "No fields to update", "pass at least one typed flag (--first/--last/--phone/--email/--memo) or a --body/--from-json patch"),
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      ...permErrors("auth.page.person.edit"),
    ],
    notes: [
      "Prefer typed flags for the common contact fields — --email/--phone map to personEmail/personPhone. Use --body/--from-json for columns without a typed flag.",
      "On Windows PowerShell inline --body JSON often fails (the shell strips the inner double-quotes, so the CLI sees e.g. {personEmail:x} unquoted) — use typed flags, or pass --from-json <file|-> (a file, or - for stdin) to avoid shell quoting entirely.",
    ],
    examples: [
      'ib person update 6268 --email jussi@ariem.fi --phone 0405164758 --reason "onboarding contact details"',
      'ib person update 5351 --phone "+358501234567" --reason "phone change"',
      'ib person update 5351 --email "" --reason "clear email"',
      'ib person update 5351 --body \'{"personPhone":"+358501234567"}\' --reason "phone change"',
      'ib person update 5351 --from-json ./patch.json --reason "phone change"',
    ],
  },
  {
    command: "ib person owner",
    description:
      "Set or clear a person's owner company (ownerAsiakasId). Provide EXACTLY ONE of --global (make the person GLOBAL/self-managing, ownerAsiakasId=null, discoverable across companies) or --asiakas <id> (assign/move ownership). This is SEPARATE from roles — a global person can still hold roles via `ib person role grant`, and from membership via `ib customer person add`. Requires --reason.",
    permissions: [
      "developer/system-admin: any person → any target",
      "self (your own personId): → null always; → a company only if you are a member of it",
      "company-admin: may release a person CURRENTLY owned by your company → global (cannot pull others in)",
    ],
    args: [{ name: "personId", type: "number", description: "personId whose owner to change" }],
    flags: [
      { name: "global", type: "boolean", description: "Make the person global (ownerAsiakasId=null)" },
      { name: "asiakas", type: "number", description: "Set owner to this asiakasId" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ personId, ownerAsiakasId } or { dryRun: true, wouldSetOwner: { personId, from, to } }",
    errors: [
      apiErr(403, "Not allowed to change this person's owner", "see the authz rules above (developer/self/company-admin)"),
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      { origin: "client", exit: 4, meaning: "Bad flags", remedy: "provide exactly one of --global / --asiakas and a --reason" },
    ],
    examples: [
      "ib person owner 5351 --global --reason 'make self-managing'",
      "ib person owner 5351 --asiakas 26 --reason 'assign to company 26'",
      "ib person owner 5351 --global --reason preview --dry-run",
    ],
  },
  {
    command: "ib person delete",
    description: "Delete a person. Requires --reason.",
    permissions: ["auth.page.person.edit"],
    args: [{ name: "personId", type: "number", description: "personId to delete" }],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ deleted: number } or { dryRun: true, wouldDelete: { personId } }",
    errors: [
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      ...permErrors("auth.page.person.edit"),
    ],
    examples: ['ib person delete 5351 --reason "departed"'],
  },

  // ─── jerry (39) — BetoniJerry marketplace ──────────────────────────────────
  {
    command: "ib jerry request list",
    description:
      "List BetoniJerry pump requests (tarjouspyynnöt). Default --mine returns the caller's own requests (GET /api/pumppuRequests/mine). --open returns the provider inbox of open requests in your delivery area (GET /api/pumppuRequests/open) and requires a provider company (isPumppuToimittaja); customer PII is masked there until your offer is accepted. --provider is the provider's own lifecycle view (GET /api/pumppuRequests/provider-list) — also provider-only, and includes your sent offers — selected by --tab <avoimet|tarjotut|voitetut|paattyneet> (default avoimet): avoimet = open requests to bid on, tarjotut = ones you have offered on (offer pending), voitetut = won (your offer accepted/confirmed), paattyneet = ended (expired, no_supply, or lost to another provider). --status (CSV) and --limit apply to --mine only. Whole-market visibility is system-admin only.",
    permissions: ["--open / --provider: provider company (isPumppuToimittaja)"],
    flags: [
      { name: "open", type: "boolean", description: "Provider inbox of open requests in your delivery area (provider role)" },
      { name: "mine", type: "boolean", description: "Your own requests (default)" },
      { name: "status", type: "string", description: "Filter --mine by status (CSV: open,pending_verification,accepted,cancelled,expired,no_supply)", allowed: ["open", "pending_verification", "accepted", "cancelled", "expired", "no_supply"] },
      { name: "limit", type: "number", default: "100", description: "Max rows for --mine (server caps at 200)" },
      { name: "provider", type: "boolean", description: "Provider lifecycle view via /provider-list (incl. sent offers)" },
      { name: "tab", type: "string", default: "avoimet", description: "With --provider: which lifecycle tab to return (avoimet|tarjotut|voitetut|paattyneet)", allowed: [...PROVIDER_LIST_TABS] },
    ],
    outputShape:
      "ListEnvelope<{ pumppuRequestId, status, createdAt, sentAt?, osoite, formattedAddress, totalM3|maaraM3, ... }> (fields differ between --mine and --open; --open is PII-masked)",
    errors: [
      apiErr(400, "Unknown --tab", "use one of avoimet, tarjotut, voitetut, paattyneet (server-validated)"),
      apiErr(403, "Not a provider (for --open / --provider)", "switch to a provider company, or use --mine"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request list"],
    examples: [
      "ib jerry request list",
      "ib jerry request list --open",
      "ib jerry request list --mine --status open,accepted --limit 50",
      "ib jerry request list --provider --tab tarjotut",
    ],
  },
  {
    command: "ib jerry request get",
    // The masking sentences at the end of this description are also stated in the
    // `jerry-lifecycle` TOPICS entry in reference/domain.ts (served by `ib help
    // jerry-lifecycle` and embedded in every `ib reference dump` primer) — keep both
    // in sync. Editing THIS file is exactly where the last drift started: c37700d
    // corrected two copies and missed domain.ts (fb#551).
    description:
      "Get one pump request. Default is the customer-owned recap (GET /api/pumppuRequests/:id, scoped to the caller's personId). --provider returns the provider-facing detail (GET /api/pumppuRequests/:id/provider-detail, requires provider role) including your own offer + attachments. This returns the FULL customer lead (name, address, lat/lng, phone, email) to every matched provider as soon as the request is open — it is NOT masked pre-acceptance. Masking applies to the `--open` inbox list and the fan-out email, not here.",
    permissions: ["--provider: provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "provider", type: "boolean", description: "Provider-facing detail view (provider role)" },
    ],
    outputShape:
      "default: { pumppuRequestId, status, asiakasId, maaraM3, osoite, lat, lng, ... } | --provider: { request:{...}, ownOffer:{...}|null, ownAttachments:[…], requestAttachments:[…], messageThreadId }",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId (and that you own it, or use --provider)"),
      apiErr(403, "Not a provider (for --provider)", "switch to a provider company"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry request get 4012", "ib jerry request get 4012 --provider"],
  },
  {
    command: "ib jerry request offers",
    description:
      "List the offers on a customer-owned request (GET /api/pumppuRequests/:id/offers). Drafts excluded; sorted pending-first then cheapest. Provider contact fields (jerryContactName/Phone, openingHours) are revealed only on the accepted offer.",
    auth: "any",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you own" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ pumppuOfferId, status, priceCents, vatPercent, availableFrom, cancellationTerms, extraNotes, priceTerms, validUntil, createdAt, updatedAt, asiakasNimi, ytunnus, asiakasId, messageThreadId, companyDescription, maintainsOrderInfo, jerryContactName, jerryContactPhone, openingHours, providerDistanceKm }> — jerryContactName/jerryContactPhone/openingHours are null on every row except the accepted offer; providerDistanceKm is null when the provider varikko or the worksite has no coordinates",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry request offers 4012", "ib jerry request offers 4012 --pretty"],
  },
  {
    command: "ib jerry request create",
    description:
      "Create a customer pump request / tarjouspyyntö (POST /api/pumppuRequests). Any authenticated user — this is the CUSTOMER side (distinct from `ib jerry offer create`, the provider bid). The worksite address is given positionally OR via --address (exactly one; both allowed only if they agree). The server geocodes the address and inserts the request as status:'open', immediately visible to every geographically-matching provider. Omit --asiakas to bill it to your auto-created private BetoniJerry customer account; pass --asiakas to use a company you have access to. Requires --reason.",
    auth: "any",
    args: [{ name: "address", type: "string", required: false, description: "Worksite address (osoite); pass it here OR as --address (exactly one)" }],
    flags: [
      { name: "address", type: "string", description: "Worksite address (osoite); alias for the positional" },
      { name: "pump-at", type: "string", description: "Pump datetime (pumppausaika; ISO, REQUIRED), e.g. 2026-06-17T09:00:00+03:00" },
      { name: "m3", type: "number", description: "Concrete volume m³ (maaraM3; REQUIRED, > 0)" },
      { name: "boom", type: "number", default: "0", description: "Required boom reach m (puomi)" },
      { name: "duration", type: "number", description: "Pump duration hours (kesto)" },
      { name: "line-length", type: "number", description: "Hose line length m (linjanPituus)" },
      { name: "notes", type: "string", description: "Free-text description shown to providers (kuvaus)" },
      { name: "asiakas", type: "number", description: "Customer asiakasId (omit → your private BetoniJerry account)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, status:'open', asiakasId, personId, tyomaaId, geocoded } · { dryRun:true, wouldCreate:{ asiakasId, osoite, pumppuAika, totalM3, requiredPuomi, pumppuKesto, requiredLinja, notes }, validation:{ ok:true } } on --dry-run",
    errors: [
      { origin: "client", exit: 4, match: "address", meaning: "Address missing, or given BOTH positionally and via --address with different values", remedy: "pass the address exactly once — positional or --address" },
      { origin: "client", exit: 4, match: "--m3", meaning: "--m3 is not a number > 0", remedy: "pass --m3 as a positive number of cubic metres" },
      apiErr(400, "Server-side validation: pumppausaika not a parseable datetime, whitespace-only osoite, or non-numeric asiakasId/puomi", "pass --pump-at as a full ISO datetime (e.g. 2026-06-17T09:00:00+03:00) and a non-empty address"),
      apiErr(403, "No access to --asiakas", "omit --asiakas, or target a company you belong to"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Customer side: creates the tarjouspyyntö itself, NOT a provider offer (that is `ib jerry offer create`).",
      "Created as status:'open' → immediately fans out to matching provider inboxes. Run `ib jerry check-address` first to preview which providers (if any) cover the address.",
      "--dry-run runs the server's synchronous validation and echoes the would-be request, touching no DB (no asiakas resolve/auto-create, no geocode, no insert) — so a bad --pump-at/--m3 still 400s under --dry-run.",
    ],
    seeAlso: ["ib jerry check-address", "ib jerry request list", "ib jerry offer create"],
    examples: [
      'ib jerry request create "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --reason "tilaus"',
      'ib jerry request create --address "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --boom 24 --notes "ahdas piha" --reason "tilaus"',
      'ib jerry request create "Mannerheimintie 1, Helsinki" --pump-at 2026-06-17T09:00:00+03:00 --m3 30 --dry-run --reason "preview"',
    ],
  },
  {
    command: "ib jerry request cancel",
    description:
      "Cancel your OWN pump request (customer-side) — allowed only while no live offer exists (POST /api/pumppuRequests/:id/cancel). Sets status='cancelled'. Requires --reason.",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you own" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, status: 'cancelled' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [
      apiErr(404, "Request not found / not yours", "verify the requestId and that you own it"),
      apiErr(409, "Already has offers", "cannot cancel once an offer arrived"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request cancel 88 --reason "tilaus peruuntui"'],
  },
  {
    command: "ib jerry request decline",
    description:
      "Decline a request as a provider WITHOUT making an offer (POST /api/pumppuRequests/:id/decline). Your company bows out; --reason is stored and shown to the customer (who is emailed + pushed that a provider passed). The request leaves your Avoimet tab (moves to Päättyneet). Blocked (409) if you already have an active offer — use `ib jerry offer withdraw` instead. Idempotent. Requires provider role + --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you were sent" }],
    flags: [{ name: "reason", type: "string", description: "Decline reason — stored, shown to the customer, and audited (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, declined: true, hasOtherProviders } (or { …, alreadyDeclined: true }) · { dryRun: true, wouldDecline: { pumppuRequestId, reason } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not a recipient", "verify the requestId and that it was sent to your company"),
      apiErr(409, "You already have an offer", "withdraw the offer instead (ib jerry offer withdraw)"),
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request decline 88 --reason "kalusto varattu kyseiselle päivälle"'],
  },
  {
    command: "ib jerry request undecline",
    description:
      "Reverse a prior decline as a provider (POST /api/pumppuRequests/:id/undecline). The request returns to your Avoimet tab and is offerable again. Idempotent (no-op success if you had not declined). No customer notification. Requires provider role + --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId you previously declined" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, undeclined: boolean } · { dryRun: true, wouldUndecline: { pumppuRequestId } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not a recipient", "verify the requestId and that it was sent to your company"),
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry request undecline 88 --reason "kalusto vapautui"'],
  },
  {
    command: "ib jerry offer create",
    description:
      "Create or update (upsert) YOUR offer on a request (POST /api/pumppuRequests/:id/offers). Provider company only (isPumppuToimittaja). A new offer starts as 'draft' (invisible to the customer) — make it visible with `ib jerry offer send`. Re-running while the offer is still draft/pending edits it in place; once accepted/rejected/withdrawn it is final (409). --price-cents is the canonical price (integer cents, 1..99999900) matching exactly what the API stores; --maintains-order-info (true|false) overrides the provider default for this offer only (omit to inherit). Requires --reason.",
    permissions: ["provider company (isPumppuToimittaja)"],
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "price-cents", type: "number", description: "Offer price in cents (REQUIRED; integer 1..99999900)" },
      { name: "vat-percent", type: "number", default: "25.5", description: "VAT percent" },
      { name: "price-terms", type: "string", description: "Price-estimate terms (Hinta-arvion ehdot) shown to the customer" },
      { name: "valid-until", type: "string", description: "Offer valid-until (ISO datetime; server default +7d)" },
      { name: "available-from", type: "string", description: "Earliest availability (ISO datetime; stored, not shown on the BetoniJerry customer card)" },
      { name: "extra-notes", type: "string", description: "Free-text notes shown to the customer" },
      { name: "cancellation-terms", type: "string", description: "Per-offer cancellation terms (stored; BetoniJerry shows a platform-standard peruutusehdot, so this is NOT rendered on the customer card)" },
      { name: "maintains-order-info", type: "string", description: "Override provider default (true|false); omit to inherit" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuOfferId, status:'draft', created, messageThreadId } · { dryRun:true, wouldUpsert:{ pumppuRequestId, priceCents, vatPercent, priceTerms, validUntil, availableFrom, extraNotes, cancellationTerms, maintainsOrderInfo } } on --dry-run",
    errors: [
      { origin: "client", exit: 4, match: "--price-cents", meaning: "--price-cents is not an integer in 1..99999900 — rejected locally before anything is sent (this guard is stricter than the server's, so a bad price never reaches a server 400)", remedy: "pass --price-cents as an integer 1..99999900 (cents, not euros)" },
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      apiErr(404, "Request not found", "verify requestId"),
      apiErr(409, "Request not open / expired, or offer no longer editable", "the request was closed, or your offer is already accepted/rejected"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      'ib jerry offer create 4012 --price-cents 45000 --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --vat-percent 25.5 --maintains-order-info false --extra-notes "sis. siirtymat" --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --price-terms "Arvioitu hinta; laskutus toteutuneen mukaan" --reason "tarjous"',
      'ib jerry offer create 4012 --price-cents 45000 --dry-run --reason "preview"',
    ],
  },
  {
    command: "ib jerry offer send",
    description:
      "Send a draft offer to the customer (draft → 'pending'; POST /api/pumppuRequests/:id/offers/:offerId/send). Provider company only; you must own the offer. Two-stage by design: create the draft, attach files, then send. Requires --reason.",
    permissions: ["provider company (isPumppuToimittaja); owns the offer"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "pumppuOfferId you own" },
    ],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuOfferId, status:'pending' } · { dryRun:true, wouldUpdate:{ pumppuRequestId, pumppuOfferId, status:'pending' } } on --dry-run",
    errors: [
      apiErr(403, "Not a provider", "switch to a provider company (company switch)"),
      apiErr(409, "Offer not in draft / not owned", "only a draft offer you own can be sent"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer send 4012 55 --reason "lahetä tarjous"', "ib jerry offer send 4012 55 --dry-run --reason preview"],
  },
  {
    command: "ib jerry offer accept",
    description:
      "Accept an offer (CUSTOMER side; POST /api/pumppuRequests/:id/offers/:offerId/accept). Flips this offer to 'accepted', sibling offers to 'rejected', and the parent request to 'accepted' in one transaction. Caller must own the request (its personId) — this is NOT a provider action. Requires --reason.",
    permissions: ["owns the request (customer personId)"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId you own" },
      { name: "offerId", type: "number", description: "pumppuOfferId to accept" },
    ],
    flags: [
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, pumppuOfferId, keikkaId:null, status:'accepted' } · { dryRun:true, wouldAccept:{ pumppuRequestId, pumppuOfferId, status:'accepted' } } on --dry-run",
    errors: [
      apiErr(404, "Request not found / not yours", "verify requestId and that you own it"),
      apiErr(409, "Offer no longer acceptable", "a sibling was already accepted, or the offer expired"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer accept 4012 55 --reason "valittu toimittaja"'],
  },
  {
    command: "ib jerry offer confirm",
    description:
      "Confirm an accepted offer (PROVIDER side; POST /api/pumppuRequests/:id/offers/:offerId/confirm).",
    permissions: ["provider company (isPumppuToimittaja); owns the offer"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "pumppuOfferId you own (must be 'accepted')" },
    ],
    flags: [
      { name: "scheduled-at", type: "string", description: "Scheduled keikka start (REQUIRED; future ISO datetime)" },
      { name: "pumppu", type: "number", description: "vehicleId to pin to the keikka (must be yours)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ pumppuRequestId, pumppuOfferId, status:'confirmed', keikkaId, scheduledAt } · { dryRun:true, wouldConfirm:{ pumppuRequestId, pumppuOfferId, status:'confirmed', scheduledAt, pumppuId } } on --dry-run",
    errors: [
      apiErr(400, "scheduledAt missing/invalid/in the past, or pumppuId not yours", "pass --scheduled-at as a future ISO datetime; --pumppu must be your vehicleId"),
      apiErr(403, "Not a provider / offer not yours", "switch to the owning provider company"),
      apiErr(404, "Request / offer not found", "verify requestId + offerId"),
      apiErr(409, "Offer not in 'accepted' state", "the customer must accept the offer before you confirm"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Heavyweight, real side effects: flips the offer accepted → 'confirmed' AND builds a keikka in your grid (broadcasts keikka:created, notifies the customer, inherits the vehicle's day driver).",
      "Call only after the customer accepts and you've agreed a date by phone.",
      "--scheduled-at (future ISO datetime) is required.",
      "--pumppu optionally pins one of your vehicles.",
    ],
    seeAlso: ["ib jerry offer accept", "ib jerry request get"],
    examples: [
      "ib jerry offer confirm 4012 55 --scheduled-at 2026-06-15T08:00:00Z --reason vahvistettu",
      "ib jerry offer confirm 4012 55 --scheduled-at 2026-06-15T08:00:00Z --pumppu 7 --dry-run --reason preview",
    ],
  },
  {
    command: "ib jerry offer withdraw",
    description:
      "Withdraw YOUR sent offer before the customer accepts it (POST /:id/offers/:offerId/withdraw). pending → withdrawn. Provider-only; you must own the offer. Requires --reason.",
    permissions: ["isProvider"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "your pumppuOfferId" },
    ],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, status: 'withdrawn' } or { dryRun: true, wouldUpdate: { pumppuOfferId, status } }",
    errors: [
      apiErr(403, "Not a provider", "use a pump-company token"),
      apiErr(404, "Offer not found / not yours", "verify requestId + offerId"),
      apiErr(409, "Already resolved", "cannot withdraw once accepted/confirmed"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer withdraw 77 5 --reason "kalusto varattu"'],
  },
  {
    command: "ib jerry offer delete",
    description:
      "Hard-delete YOUR OWN DRAFT offer (DELETE /:id/offers/:offerId). Provider-only; you must own the offer; DRAFT status ONLY — a sent offer (pending/accepted/…) returns 409, use `ib jerry offer withdraw` for a pending one. The offer's attachments are soft-deleted server-side; the (request, provider) message thread is left in place for reuse. Requires --reason.",
    permissions: ["isProvider"],
    args: [
      { name: "requestId", type: "number", description: "pumppuRequestId" },
      { name: "offerId", type: "number", description: "your DRAFT pumppuOfferId" },
    ],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, pumppuOfferId, deleted: true } or { dryRun: true, wouldDelete: { pumppuOfferId, status } }",
    errors: [
      apiErr(403, "Not a provider", "use a pump-company token"),
      apiErr(404, "Offer not found / not yours", "verify requestId + offerId"),
      apiErr(409, "Not a draft", "only a draft offer can be deleted; use withdraw for a sent offer"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry offer delete 77 5 --reason "väärä luonnos"'],
  },
  {
    command: "ib jerry counts",
    description:
      "Lifecycle counts. Default --mine returns the customer view (GET /api/pumppuRequests/mine/counts: draft/open/pending_verification/accepted/cancelled/expired/no_supply). --provider returns the provider badge counts (GET /api/pumppuRequests/provider-counts: avoimet/tarjotut/voitetut/voitetutActionRequired/paattyneet) plus this company's Jerry membership state, and requires a provider company.",
    permissions: ["--provider: provider company (isPumppuToimittaja)"],
    flags: [
      { name: "provider", type: "boolean", description: "Provider badge counts (provider role)" },
      { name: "mine", type: "boolean", description: "Customer counts (default)" },
    ],
    outputShape:
      "--mine: { draft, open, pending_verification, accepted, cancelled, expired, no_supply } | --provider: { avoimet, tarjotut, voitetut, voitetutActionRequired, paattyneet, supportUnread, jerryActive, application: { status, createdTime } | null }",
    errors: [
      apiErr(403, "Not a provider (for --provider)", "switch to a provider company, or use --mine"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--provider carries three non-count keys beyond the badge numbers: supportUnread (per-PERSON, not per-company: support threads with a message you have not read), jerryActive (the HAS_JERRY setting is on — the company is live in the marketplace), and application (this company's own jerryOnboarding row, null when it never applied). jerryActive is the cheapest single answer to 'is my company live in Jerry?'.",
    ],
    examples: ["ib jerry counts", "ib jerry counts --provider"],
  },
  {
    command: "ib jerry stats",
    description:
      "Weekly BetoniJerry funnel as a time series (GET /api/admin/jerry-searches/weekly): visitors → address searches → wizard sessions → requests sent → offers. Monday-start weeks, oldest first. This is the trend view; `ib jerry counts` is the lifecycle snapshot of your own requests. Use it to answer 'is demand growing' and 'are providers still answering', neither of which a single-window number can show.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "weeks", type: "number", description: "How many weeks back (default 12, capped at 104)" },
    ],
    outputShape:
      "{ weeks: [{ weekStart, visitors, wizardVisitors, authedVisitors, searches, coveredSearches, noSupplySearches, wizardSessions, reachedReview, requestsSent, noSupplyRequests, offersSent, offersAccepted }] }",
    errors: [
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request stats", "ib jerry admin searches funnel", "ib jerry counts"],
    notes: [
      "`visitors` is null — not 0 — for any week before 2026-08-12, when the daily visitor rollup started. The presence heartbeat was ephemeral until then, so those weeks have no visitor number and never can. Reading a null as 0 would say 'nobody came' when the truth is 'we were not counting yet'.",
      "`wizardSessions` counts only PRE-CLAIM sessions: BetonijerryAnonymousEvent stops recording once a server draft exists, so a returning logged-in user who resumes a draft is invisible here. It undercounts, and the gap widens as more traffic is authenticated — do not read it as total wizard usage.",
      "`reachedReview` means 'completed step 4', i.e. landed on Vaihe 5 (tarkista). It is NOT step >= 5, which is structurally 0 because the wizard emits a step only when advancing off it and Vaihe 5 ends in Lähetä (fb#457).",
      "`offersSent` excludes drafts — an unsent draft offer is not an answer to the customer. `offersAccepted` counts both 'accepted' and 'confirmed'.",
      "Not to be confused with `ib jerry admin request stats`, which is also weekly but covers ONLY requests (with a per-status split and an arbitrary --from/--to window). Use that one to dissect request outcomes; use this one to see the whole funnel end to end, including the demand upstream of any request. Both bucket in Helsinki time and agree on which week a request belongs to.",
    ],
    examples: ["ib jerry stats", "ib jerry stats --weeks 26"],
  },
  {
    command: "ib jerry check-address",
    description:
      "Geofence feasibility probe (POST /api/pumppuRequests/checkAddress; the route is unauthenticated, but ib calls it with your session): which provider varikot cover an address. The single best tool for diagnosing 'no offers'. --address is required (the `osoite` body field); if --lat/--lng/--place-id are all supplied the server trusts them instead of re-geocoding. Not a mutation, so no write-safety flags. Rate-limited 20/min per IP. The `providers` array is only included when the token is a developer/admin.",
    auth: "any",
    flags: [
      { name: "address", type: "string", description: "Street address to check (REQUIRED; sent as `osoite`)" },
      { name: "lat", type: "number", description: "Latitude (trusted only with --lng + --place-id)" },
      { name: "lng", type: "number", description: "Longitude (trusted only with --lat + --place-id)" },
      { name: "place-id", type: "string", description: "Google placeId (lets the server trust client coords)" },
      { name: "formatted-address", type: "string", description: "Google formatted address" },
      { name: "boom", type: "number", description: "Required boom (m) — keeps varikot with enough REACH: puomiMax NULL or >= it (absent/0 = no boom filter)" },
      { name: "explain", type: "boolean", description: "Add considered[] — per-varikko exclusion reasons for non-matching depots (developer/admin only)" },
      { name: "gate", type: "string", description: "With --explain: CSV of exclusion reasons to include (company-gate|provider-dead|no-coords|not-enrolled|radius|boom). Default omits company-gate", allowed: [...CHECK_ADDRESS_GATES] },
      { name: "asiakas", type: "number", description: "With --explain: force-include this company's varikot even if not yet Jerry-enabled (surfaces company-gate)" },
    ],
    outputShape:
      "{ geocoded: boolean, deliverable?: boolean, lat?, lng?, placeId?, formattedAddress?, providerCount?, nearestVarikkoKm?, providers?: [{ asiakasId, asiakasNimi, distanceKm }], considered?: [{ asiakasId, asiakasNimi, sijaintiId, excludedBy: 'company-gate'|'provider-dead'|'no-coords'|'not-enrolled'|'radius'|'boom', detail }], consideredSuppressed?: { [gate]: count } }",
    errors: [
      apiErr(400, "Empty/whitespace-only --address (an omitted --address is caught locally by the parser, which answers with its own prescriptive envelope)", "pass a non-empty street address"),
      { origin: "client", exit: 4, match: "--boom", meaning: "--boom not a non-negative number", remedy: "pass metres ≥ 0, or omit for no boom filter" },
      { origin: "client", exit: 4, match: "--asiakas", meaning: "--asiakas without --explain, or not a positive integer", remedy: "add --explain, or pass a positive asiakasId" },
      { origin: "client", exit: 4, match: "--gate", meaning: "--gate without --explain, or an unknown reason name", remedy: "add --explain; valid reasons are company-gate, provider-dead, no-coords, not-enrolled, radius, boom" },
      apiErr(429, "Rate limit (20/min/IP)", "wait and retry"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "A varikko counts toward providerCount only when ALL of these hold: the company has isPumppuToimittaja = 1, the company has the HAS_JERRY setting on (ib jerry admin enable), the sijainti is enrolled (jerryActiveUntil in the future, ib sijainti set-jerry --on) with maxDeliveryDistance covering the point, and — when a boom is stated — the sijainti has enough reach (puomiMax IS NULL or >= boom; puomiMin is stored but NOT matched on, fb#415).",
      "--explain answers 'why no offers?': considered[] lists the NON-matching varikot (passing ones are in providers[]), each tagged with the FIRST gate it failed. Gate priority puts COMPANY-level reasons above DEPOT-level ones — company-gate → provider-dead → no-coords → not-enrolled → radius → boom — so the reason reported is the most upstream blocker, the one to fix first: adding coordinates to a depot changes nothing for a company that was never enrolled. Business-sensitive, so returned only to developer/admin tokens, exactly like providers[].",
      "company-gate is OMITTED by default: it only says 'this company was never in the programme', and on a live Helsinki probe it was 93 of 110 rows across 17 companies, burying the actionable ones. Whatever is withheld is counted in consideredSuppressed, so nothing disappears silently. Pass --gate company-gate (alone or with others) to see it, or --asiakas <id> to surface it for ONE company during onboarding — which is when it is a real answer.",
      "--gate narrows further: --gate no-coords,radius answers 'which enrolled depots are misconfigured?' without the rest. An unknown reason name exits 4 rather than silently narrowing the view, since a shorter list reads as 'nothing else is wrong'.",
    ],
    seeAlso: ["ib jerry admin list"],
    examples: [
      "ib jerry check-address --address 'Mannerheimintie 1, Helsinki'",
      "ib jerry check-address --address 'Hämeenkatu 1, Tampere' --lat 61.498 --lng 23.761 --place-id ChIJxxxx",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain --gate no-coords,not-enrolled",
      "ib jerry check-address --address 'Kauppakatu 5, Jyväskylä' --explain --asiakas 812",
    ],
  },
  {
    command: "ib jerry coverage",
    description:
      "Developer view of BetoniJerry supply coverage: the candidate-area table (covered + not, with providerCount + region) plus every enrolled provider depot circle (company, lat/lng, delivery radius km, boom range). Reuses the live geofence rule (services/varikkoMatching + modules/betonijerry/coverageAreas), so it matches real request feasibility. Use it to align ad geo-targeting to actual supply.",
    auth: "any",
    tier: "developer",
    flags: [],
    outputShape:
      "{ summary: { varikkoCount, providerCount, coveredAreas, coveredRegions: string[] }, coveredRegions: string[], areas: { key, listLocative, tailRegion, probeLat, probeLng, covered, providerCount }[], varikot: { asiakasId, asiakasNimi, sijaintiId, sijaintiNimi, lat, lng, maxDeliveryDistanceKm, puomiMin, puomiMax, jerryActiveUntil }[], computedAt } — `coveredRegions` (distinct tailRegions of covered areas) is the Google-Ads geo-targeting answer.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib jerry coverage"],
  },
  {
    command: "ib jerry email-activity",
    description:
      "Developer SendGrid deliverability diagnostic for betonijerry.fi (GET /api/betonijerry/email-activity). READ-ONLY: reports domain-authentication validity (DKIM/DMARC), aggregate send stats over the window (delivered/bounces/spam with rate %), and recent suppressions (bounces/blocks/spam_reports/invalid_emails, incl. how many are @betonijerry.fi). Backed by a SEPARATE read-only SendGrid key on the server (KV sendgrid-diag-key) — never the app's mail.send key; the report includes a key.readOnly guardrail. Use it to watch deliverability as email volume grows (e.g. the re-added loser-notification #5).",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "days", type: "number", default: "7", description: "Window in days (1..90)" },
      { name: "domain", type: "string", default: "betonijerry.fi", description: "Sending domain to report on" },
    ],
    outputShape:
      "{ domain, days, checkedAt, key:{ readOnly, hasWhitelabel, hasSuppression, hasStats }, domainAuth:{ valid, records:{ mail_cname, dkim1, dkim2 } }, suppressions:{ bounces|blocks|spam_reports|invalid_emails: { count, forDomain, recent[] } }, stats:{ delivered, bounces, spam_reports, bounceRatePct, spamRatePct }, verdict:{ domainAuthValid, deliverabilityFlags[] } }",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(503, "Diagnostic key not configured on this backend", "set KV secret sendgrid-diag-key (read-only SendGrid key)"),
    ],
    examples: ["ib jerry email-activity", "ib jerry email-activity --days 30 --pretty"],
  },
  {
    command: "ib jerry provider-settings get",
    description:
      "Read a provider company's BetoniJerry settings — contact person, opening hours, company description, maintainsOrderInfo (GET /api/jerry-provider-settings). Defaults to the caller's own company; --asiakas targets another company you have edit rights on. Returns defaults when no row exists yet.",
    permissions: ["edit-tier on the target company (tarjousAdmin / company admin)"],
    flags: [
      { name: "asiakas", type: "number", description: "Target company asiakasId (default: your own)" },
    ],
    outputShape:
      "{ asiakasId, jerryPersonId, jerryPersonName, jerryPersonPhone, jerryPersonEmail, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsentAt, publicListingConsentBy }",
    errors: [
      apiErr(403, "No edit rights on company", "use a tarjousAdmin/admin token for that company"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry provider-settings get", "ib jerry provider-settings get --asiakas 1402"],
  },
  {
    command: "ib jerry provider-settings set",
    description:
      "Upsert a provider company's BetoniJerry settings (PUT /api/jerry-provider-settings). Partial-payload-safe: only the body keys present are written (omit a key to preserve it). jerryPersonId must belong to the target company. --asiakas targets another company. Returns the FULL saved settings (no follow-up GET needed) plus changed:boolean (whether anything actually changed vs an idempotent no-op). companyDescription is nvarchar — ä/ö are preserved. Requires --reason. Writable keys: jerryPersonId, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsent. `publicListingConsent` is a BOOLEAN intent flag — the server stamps publicListingConsentAt/By from your token; never send a timestamp. Re-granting an already-granted consent does not re-stamp the original date. On Windows PowerShell use --from-json <file>: PowerShell splits a quoted --body value on its inner double-quotes.",
    permissions: ["edit-tier on the target company (tarjousAdmin / company admin)"],
    flags: [
      { name: "body", type: "json", description: "JSON: { jerryPersonId?, offerNotificationEmail?, openingHours?, companyDescription?, maintainsOrderInfo?, website?, publicSlug?, publicListingConsent? }. Mutually exclusive with --from-json. ⚠ Windows PowerShell splits this argument on its inner double-quotes, so inline JSON arrives mangled and exits 4 as a too-many-arguments usage error — use --from-json <file|-> there, or typed flags (fb#437; see `ib help shell-quoting`)." },
      { name: "from-json", type: "string", description: "Read the JSON body from a file (or - for stdin); shell-safe alternative to --body. Mutually exclusive with --body." },
      { name: "email", type: "string", description: "Address tarjouspyyntö mail is DELIVERED to (offerNotificationEmail). May be a shared inbox — it is a mailbox, not a login, so jerryPersonId stays a named person who signs in. Wins over jerryPersonId's own address when set, and over the same key in --body; " + clearHint("--email") + " and fall back to it." },
      { name: "asiakas", type: "number", description: "Target company asiakasId (default: your own)" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ asiakasId, jerryPersonId, jerryPersonName, jerryPersonPhone, jerryPersonEmail, offerNotificationEmail, openingHours, companyDescription, maintainsOrderInfo, website, publicSlug, publicListingConsentAt, publicListingConsentBy, changed } · { dryRun: true, wouldUpdate: {...} } on --dry-run",
    errors: [
      apiErr(400, "Invalid field / contact not in company", "check jerryPersonId belongs to the company; offerNotificationEmail must be a valid address"),
      apiErr(403, "No edit rights on company", "use a tarjousAdmin/admin token for that company"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "On Windows PowerShell inline --body JSON often fails (the shell strips the inner double-quotes) — pass --from-json <file|-> (a file, or - for stdin) to avoid shell quoting entirely.",
      "Before fb#532 jerryPersonId did both jobs — WHERE offer mail lands and WHO signs in — which pushed operators into configuring shared login accounts. The welcome email forbids those on GDPR/audit grounds, and the one account set up that way went three weeks without a single login.",
    ],
    examples: [
      'ib jerry provider-settings set --body \'{"openingHours":"ma-pe 7-16","maintainsOrderInfo":true}\' --reason "update opening hours"',
      'ib jerry provider-settings set --from-json ./settings.json --reason "update opening hours"',
      'ib jerry provider-settings set --body \'{"jerryPersonId":6233}\' --asiakas 1402 --reason "set contact"',
      'ib jerry provider-settings set --email tarjoukset@yritys.fi --asiakas 1409 --reason "route offers to the shared inbox"',
    ],
  },
  {
    command: "ib jerry admin list",
    description:
      "List Jerry-active companies (isPumppuToimittaja + HAS_JERRY setting) with per-company counts (admins, tarjousAdmins, pumpparit, vehicles, Jerry/non-Jerry varikot, matchable varikot) AND login reality (lastLoginTime, jerryContactLastLoginTime). GET /api/admin/jerry-companies. System-admin only. TWO health checks: matchableVarikkoCount 0 means Jerry-active but its varikot fail the geofence, so it CANNOT receive a tarjouspyyntö (diagnose with `ib jerry check-address --explain`); jerryContactLastLoginTime null means it receives them but the contact they are mailed to has never signed in, so nobody there can open one.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "with-notification", type: "boolean", description: "Add the RESOLVED tarjouspyyntö recipient to every row (notificationSource / notificationEmail / notificationRecipientCount) — the whole fleet's real notification addresses in ONE call. Opt-in: costs the backend 1-4 extra queries per company." },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, asiakasNimi, adminCount, tarjousAdminCount, pumppariCount, vehicleCount, sijaintiJerryCount, sijaintiNonJerryCount, ajoneuvotEnabled, matchableVarikkoCount?, lastLoginTime?, jerryContactPersonId?, jerryContactLastLoginTime?, notificationSource?, notificationEmail?, notificationRecipientCount? }>. The three notification* fields appear only with --with-notification. matchableVarikkoCount counts varikot that pass the REAL fan-out geofence (enrolled AND coords AND maxDeliveryDistance > 0); sijaintiJerryCount counts enrolment only, so matchableVarikkoCount 0 with sijaintiJerryCount > 0 means the company is Jerry-active but invisible to every tarjouspyyntö. lastLoginTime is the MAX over the company's admins/tarjousAdmins; jerryContactLastLoginTime is the jerry contact's own — they differ when the company is alive but the notified address is dead. jerryContactPersonId null means no contact is configured at all (a different defect from a configured contact who never signed in).",
    errors: [
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "The health check is `matchableVarikkoCount === 0 && sijaintiJerryCount > 0` — Jerry-active, varikot enrolled, yet invisible to every tarjouspyyntö. Diagnose the individual depot with `ib jerry check-address --explain`.",
      "The second health check is `jerryContactLastLoginTime === null` — the enrolment is live and mailed, but the recipient has never signed in, so they cannot see customer details or leave an offer. Two providers sat like this for weeks looking identical to healthy rows; finding them used to need a per-person `ib person activity` sweep (fb#532). Remedy: re-send the tervetuloa email (it now explains the one-time-code login), or check whether offerNotificationEmail should carry the shared inbox instead.",
      "--with-notification is the third check, and the one jerryContactPersonId cannot answer: it reports the RESOLVED address per provider and which branch produced it (offerNotificationEmail | jerryContactPerson | billingEmail | adminUser). Scan for `billingEmail` (the request lands in an invoicing inbox, not with a person who can answer it) and for a null source (the chain reached NOBODY). Resolved by the same function the real send calls, so it cannot drift from what is emailed (fb#567).",
    ],
    seeAlso: ["ib jerry check-address", "ib jerry admin detail"],
    examples: ["ib jerry admin list", "ib jerry admin list --pretty", "ib jerry admin list --with-notification"],
  },
  {
    command: "ib jerry admin search",
    description:
      "Search companies NOT yet fully Jerry-enabled, for the Add picker (GET /api/admin/jerry-companies/search?q=). Name LIKE match, min 2 chars, top 20. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "query", type: "string", required: false, description: "name search (min 2 chars) — or pass --search" }],
    flags: [
      { name: "search", type: "string", description: "Search query (alias for the <query> positional)" },
    ],
    outputShape: "ListEnvelope<{ asiakasId, name }>",
    errors: [
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry admin search Betoni"],
  },
  {
    command: "ib jerry admin detail",
    description:
      "Company Jerry drill-down: people by role (admins/tarjousAdmins/pumpparit) WITH each person's lastLoginTime, vehicles, and each sijainti's Jerry enrolment status (GET /api/admin/jerry-companies/:asiakasId/detail). System-admin only. Use it to name WHO at a company has never signed in once `ib jerry admin list` flags the company (fb#532).",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
    ],
    outputShape:
      "{ admins:[{personId,name,lastLoginTime}], tarjousAdmins:[…], pumpparit:[…], vehicles:[{vehicleId,vehicleRegNo}], sijainnit:[{sijaintiId,name,isJerry}], notification:{jerryPersonId,source,recipients:[{email,name,personId}]} }. lastLoginTime null = that person has never signed in.",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "`notification` answers WHERE this provider's tarjouspyyntö actually lands, and WHICH branch produced it: source is offerNotificationEmail | jerryContactPerson | billingEmail | adminUser, in that precedence. It is resolved by the same function the real send calls, so it cannot drift from what is emailed (fb#567).",
      "`source: \"billingEmail\"` is an operational smell — the request reaches an invoicing inbox rather than a person who can answer it. `source: null` with empty recipients is worse: the chain fell through every branch and NOBODY is notified.",
      "`notification.jerryPersonId` is the CONFIGURED contact, which is a different question from the resolved one: an explicit offerNotificationEmail outranks it, so a company can have a contact set and still be notified elsewhere.",
      "Deploy-gated: `notification` is simply absent against a backend that predates it.",
    ],
    seeAlso: ["ib jerry admin list"],
    examples: ["ib jerry admin detail 1402", "ib jerry admin detail --asiakas 1402"],
  },
  {
    command: "ib jerry admin enable",
    description:
      "Enable the BetoniJerry module for a company — the audited toggle that sets BOTH isPumppuToimittaja and the HAS_JERRY setting (POST /api/admin/jerry-companies/:asiakasId/enable), auto-provisions the modules a provider needs, and returns a readiness `validation` payload naming what it could NOT provision. Change-tracked via the asiakasSql proc paths. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape:
      "{ success: true, validation?: { ok, summary: { [severity]: 'passed/total' }, missing: [{ id, severity, titleFi, detail }] } } or { dryRun: true, wouldUpdate: { asiakasId, enable: true } }",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      SYSADMIN_403,
      apiErr(404, "Company not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "`validation` is the post-enable readiness summary — the `jerry` validation profile re-run against the company, with `missing` listing the still-failing checks (TarjousAdmin role, grid vehicle, Jerry-ready varikko coordinates, complete contact details): the parts that need real data and cannot be auto-provisioned. Enable itself already committed, so a non-ok validation is a TODO list, not a failure.",
      "It is best-effort and enable-only: the key is ABSENT (not null) when the validation run itself fails, and `disable` never returns it. Re-run the same checks any time with `ib validate --profile jerry --asiakas <id>`.",
    ],
    seeAlso: ["ib validate"],
    examples: ['ib jerry admin enable 1402 --reason "onboard provider"', "ib jerry admin enable --asiakas 1402 --dry-run --reason preview"],
  },
  {
    command: "ib jerry admin disable",
    description:
      "Disable the BetoniJerry module for a company — clears BOTH isPumppuToimittaja and the HAS_JERRY setting (POST /api/admin/jerry-companies/:asiakasId/disable). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", required: false, description: "company asiakasId (or pass --asiakas)" }],
    flags: [
      ASIAKAS_TARGET_FLAG,
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true } or { dryRun: true, wouldUpdate: { asiakasId, enable: false } }",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a numeric asiakasId"),
      SYSADMIN_403,
      apiErr(404, "Company not found", "verify asiakasId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin disable 1402 --reason "offboard provider"', "ib jerry admin disable --asiakas 1402 --dry-run --reason preview"],
  },
  {
    command: "ib jerry admin onboarding list",
    description:
      "List provider-onboarding prospects — pipeline status, tier, outreach contact, live Jerry-active flag, and muistutusDue (email1b reminder due) per company (GET /api/admin/jerry-onboarding). Filters: --status, --tier, --due (client-side on muistutusDue), --search (client-side substring on company name / outreach / contact fields). System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: `Filter by pipeline status key: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
      { name: "tier", type: "number", description: "Tier filter (1 priority / 2 secondary)" },
      { name: "due", type: "boolean", description: "Only rows where the email1b reminder is due (parked rows are excluded — a hold suppresses the reminder until it lapses)" },
      { name: "search", type: "string", description: "Case-insensitive substring on asiakasNimi / outreachName / outreachEmail / contactPersonName / contactPersonEmail" },
    ],
    outputShape:
      "ListEnvelope<{ asiakasId, asiakasNimi, tier, status, alue, outreachEmail, muistiinpanot, jerryActive, lastEventTime, lastNote, lastNoteType, lastNoteTime, parkedUntil, parked, muistutusDue }>",
    errors: [SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    notes: [
      "`lastNote` previews (200 chars) the most recent HUMAN-written event — note/call/response, with `lastNoteType` naming which — so the reason behind a status is visible without opening the trail. `status` alone cannot tell a ruled-out prospect from a deliberately held one; read `lastNote`/`muistiinpanot` before acting on a terminal status, and `ib jerry admin onboarding events <asiakasId>` for the full history. Deploy-gated: the three lastNote* fields are absent until puminet5api ships them.",
    ],
    seeAlso: ["ib jerry admin onboarding events"],
    examples: ["ib jerry admin onboarding list --due", "ib jerry admin onboarding list --search transsinkko"],
  },
  {
    command: "ib jerry admin onboarding add",
    description:
      "Add a company to the provider-onboarding pipeline (POST /api/admin/jerry-onboarding). One row per asiakasId; duplicate exits 4. Emails are NOT sent via CLI — sending stays a human action in /admin. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "tier", type: "number", description: "1 priority / 2 secondary" },
      { name: "malli", type: "string", description: "Email variant label — FREE TEXT (not server-validated); the convention is A or B" },
      { name: "kanava", type: "string", description: "Preferred channel, free text" },
      { name: "alue", type: "string", description: "Operating area ({alue} merge field)" },
      { name: "company-type", type: "string", description: "Company category: pumppu | betoni | all | owner", allowed: [...COMPANY_TYPES] },
      { name: "source", type: "string", default: "manual", description: "How the prospect entered the pipeline: manual | import | scheduled", allowed: [...ONBOARDING_SOURCES] },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ jerryOnboardingId } · { dryRun: true, wouldCreate: { asiakasId } } on --dry-run",
    errors: [
      apiErr(400, "Prospect already exists / company not found / unknown --source or --company-type", "check asiakasId; --source is manual|import|scheduled, --company-type is pumppu|betoni|all|owner"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin onboarding add 1389 --tier 2 --alue "Oulu" --source scheduled --reason "uusi yritys rekisterista"'],
  },
  {
    command: "ib jerry admin onboarding set",
    description:
      "Partial-update an onboarding prospect (PUT /api/admin/jerry-onboarding/:asiakasId) — status, tier, notes, outreach contact override. Only the flags you pass are written; a status change also writes a status_change history event. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "status", type: "string", description: `Pipeline status key: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
      { name: "tier", type: "number", description: "1/2" },
      { name: "malli", type: "string", description: "Email variant label — FREE TEXT (not server-validated); the convention is A or B" },
      { name: "kanava", type: "string", description: "Preferred channel" },
      { name: "alue", type: "string", description: "Operating area" },
      { name: "company-type", type: "string", description: "Company category: pumppu | betoni | all | owner", allowed: [...COMPANY_TYPES] },
      { name: "notes", type: "string", description: "muistiinpanot" },
      { name: "outreach-name", type: "string", description: "Contact override name" },
      { name: "outreach-email", type: "string", description: "Contact override email" },
      { name: "outreach-phone", type: "string", description: "Contact override phone" },
      { name: "parked-until", type: "string", description: "Hold the prospect until this date (YYYY-MM-DD or today/tomorrow); " + clearHint("--parked-until") + " and lift the hold. Does NOT change --status" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ success: true } · { dryRun: true, wouldUpdate: { asiakasId, fields } } on --dry-run",
    notes: [
      "--parked-until is how you defer a prospect. Do NOT park by moving --status to a terminal key: status holds ONE fact, so overwriting it destroys the pipeline position the prospect actually reached, and the row then misstates its own history. A parked row keeps its true status, reports `parked: true`, and is suppressed from `--due` until the date passes — after which it surfaces again by itself. The change is also written to the event trail. Deploy-gated: needs the 2026-08-10-jerry-onboarding-parked-until migration.",
    ],
    errors: [
      apiErr(400, "Unknown --status or --company-type, or malformed --parked-until", "use one of the status keys listed on --status; --company-type is pumppu|betoni|all|owner; --parked-until must be YYYY-MM-DD or empty (`--parked-until=` on PowerShell)"),
      apiErr(404, "Prospect not found", "add it first: ib jerry admin onboarding add"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin onboarding set 1389 --status vastasi_kylla --reason "vastasi puhelimessa"'],
  },
  {
    command: "ib jerry admin onboarding events",
    description:
      "Read a prospect's contact history, newest-first (GET /api/admin/jerry-onboarding/:asiakasId/events) — the append-only trail of calls, responses, notes, status_change moves and email_sent snapshots. This is where a decision's REASON lives: the prospect row carries only the current status, so a terminal status like `ei_sovellu` is indistinguishable from a deliberate hold until you read the trail. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "type", type: "string", description: "Only this event kind. call/response/note are caller-written; status_change and email_sent are written by the backend", allowed: [...ONBOARDING_EVENT_TYPES_ALL] },
      { name: "limit", type: "number", description: "Keep only the newest N events (sets `truncated`)" },
      { name: "full", type: "boolean", description: `Return complete emailBody snapshots instead of the ${ONBOARDING_EVENT_BODY_CAP}-char preview` },
    ],
    outputShape:
      "ListEnvelope<{ jerryOnboardingEventId, asiakasId, eventType, eventText, templateKey, emailTo, emailSubject, emailBody, eventTime, createdByPersonId, createdTime }> — `hint` names how many emailBody snapshots were cut",
    errors: [
      apiErr(400, "Invalid asiakasId", "pass a positive integer asiakasId"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      `emailBody is capped at ${ONBOARDING_EVENT_BODY_CAP} chars unless --full — one welcome-email snapshot is ~3 KB and a few of them bury the rest of the timeline. Neither reduction is silent: --limit sets "truncated", the body cut sets "hint".`,
      "eventTime is the BUSINESS time (backdatable via `onboarding note --time`); createdTime is when the row was written. They differ on any imported or backdated event, so order by eventTime when reconstructing what happened.",
    ],
    seeAlso: ["ib jerry admin onboarding note", "ib jerry admin onboarding list"],
    examples: [
      "ib jerry admin onboarding events 1414",
      "ib jerry admin onboarding events 1414 --type note",
      "ib jerry admin onboarding events 1414 --type email_sent --full",
    ],
  },
  {
    command: "ib jerry admin onboarding note",
    description:
      "Append a call/response/note event to a prospect's contact history (POST /api/admin/jerry-onboarding/:asiakasId/events). --time backdates; --set-status also moves the pipeline status (a second, best-effort step — see NOTES). To READ the history use `ib jerry admin onboarding events`. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "asiakasId", type: "number", description: "company asiakasId" }],
    flags: [
      { name: "type", type: "string", description: "Event kind: call | response | note; REQUIRED", allowed: [...ONBOARDING_EVENT_TYPES] },
      { name: "text", type: "string", description: "Event text; REQUIRED" },
      { name: "time", type: "string", description: "Backdated event time. Offset-less (2026-08-11T12:00) = Helsinki wall-clock; a zoned form (…+03:00, …Z) is converted to that instant" },
      { name: "set-status", type: "string", description: `Also set the pipeline status. Keys: ${ONBOARDING_STATUS_KEYS}`, allowed: [...ONBOARDING_STATUSES] },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ jerryOnboardingEventId } · { jerryOnboardingEventId, statusUpdated: false } when --set-status failed AFTER the event was written · { dryRun: true, wouldLog: { asiakasId, eventType, setStatus } } on --dry-run",
    errors: [
      apiErr(400, "Invalid eventType / missing text / unknown --set-status", "type must be call, response or note; --set-status must be a known pipeline status key. Reading the history instead? That is `ib jerry admin onboarding events <asiakasId>`"),
      { origin: "client", exit: 4, meaning: "--time is not a parseable ISO 8601 timestamp, or a component is out of range", remedy: "pass Helsinki wall-clock (2026-08-11T12:00) or a zoned form (2026-08-11T12:00:00+03:00)" },
      apiErr(404, "Prospect not found", "add it first: ib jerry admin onboarding add"),
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--set-status is NOT atomic with the event write: the event is inserted first, then the status update + its status_change event. If that second step fails the call still returns 200 with `statusUpdated: false` and the event already persisted — check for that key rather than assuming a 200 moved the status. A --set-status equal to the current status is a no-op (no status_change event).",
      "`ib jerry admin onboarding log` is a hidden back-compat alias for this command. It was renamed because every other `ib … log` is an audit-trail READ, so callers reached for it to read a prospect's history and got a usage error.",
      "--time is normalized to a UTC instant BEFORE the POST. An offset-less value is read as Europe/Helsinki (the timezone every date flag here documents), so `--time 2026-08-11T12:00` stores 09:00Z in summer. Until 2026-08-12 the raw string was posted and the offset was DROPPED rather than applied — `12:00:00+03:00` stored as 12:00Z, skewing every backdated event by 2-3 h with an HTTP 200 and no signal (fb#412). Onboarding events are append-only, so verify with `ib jerry admin onboarding events <asiakasId>` before relying on a backfilled timestamp.",
    ],
    seeAlso: ["ib jerry admin onboarding events"],
    examples: ['ib jerry admin onboarding note 1389 --type call --text "puhuttiin Jussin kanssa, kiinnostunut" --set-status vastasi_kylla'],
  },
  {
    command: "ib jerry admin request list",
    description:
      "System-wide tarjouspyyntö list with offer summary — date, customer, placing operator, worksite, m³, status, offer count, accepted/best price (GET /api/admin/jerry-requests). Filters: --status (CSV), --from/--to (createdAt), --customer, --provider, --limit. --provider does not only filter, it WIDENS every row with that company's own fan-out state — see OUTPUT. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: "Status CSV: draft,open,no_supply,pending_verification,accepted,cancelled,expired", allowed: [...ADMIN_REQUEST_STATUSES] },
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "customer", type: "number", description: "Customer asiakasId" },
      { name: "provider", type: "number", description: "Provider asiakasId" },
      { name: "limit", type: "number", default: "300", description: "Max rows (max 300)" },
    ],
    outputShape:
      "ListEnvelope<{ pumppuRequestId, status, createdAt, sentAt, expiresAt, customerAsiakasId, customerNimi, operatorName, osoite, totalM3, kayttokohde, offerCount, acceptedPriceCents, bestPriceCents, sourceChannel }>. Under --provider each row ALSO carries provider: { notifiedAt, viewedAt, viewSource, viewedByPersonId, declinedAt, declineReason, offerStatus, offerPriceCents } — that one company's own fan-out state. `viewSource` is 'authenticated' | 'link' | null and is the field to read, NOT viewedAt: it separates a provider who signed in and opened the lead from somebody who clicked the tokenized link in the notification email, which viewedAt alone conflates (fb#638).",
    errors: [
      { origin: "client", exit: 4, match: "--status", meaning: "Unknown status in --status. Rejected locally because the server DROPS an unrecognised status from its filter and returns every status when that empties it — a silently wider answer", remedy: `use only: ${ADMIN_REQUEST_STATUSES.join(", ")}` },
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib jerry admin request stats"],
    examples: ["ib jerry admin request list --status open,accepted", "ib jerry admin request list --provider 1402 --from 2026-06-01"],
  },
  {
    command: "ib jerry admin request stats",
    description:
      "Windowed tarjouspyyntö rollup — per-bucket counts with the status split and offer summary (GET /api/admin/jerry-requests/stats). The aggregate sibling of `request list`: answers 'how many per week?' in one call instead of pulling every row and bucketing client-side. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "group-by", type: "string", default: "week", description: "Bucket by week | month | status", allowed: [...REQUEST_STATS_GROUPS] },
    ],
    outputShape:
      "{ groupBy, from, to, buckets: [{ bucket, total, byStatus: { [status]: count }, offerCount, withOffers }], totals: { total, byStatus, offerCount, withOffers } }",
    errors: [
      apiErr(400, "Invalid groupBy", "use week, month or status"),
      { origin: "client", exit: 4, match: "--group-by", meaning: "--group-by is not week/month/status", remedy: "pass one of week, month, status" },
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Bucketing happens in SQL in HELSINKI time, not UTC: a Sunday-evening request belongs to the week a Finnish reader would put it in. Weeks are ISO weeks labelled with the ISO YEAR, so a week straddling New Year stays one bucket — 2027-01-03 is `2026-W53`, not `2027-W53`.",
      "`withOffers` counts requests that received at least one non-draft offer; `offerCount` sums the offers themselves. With --group-by status the bucket IS the status, so byStatus has a single key — useful as a plain status breakdown for the window.",
      "Unlike `request list` there is no row cap, so totals stay correct as volume grows (the list caps at 300 and would silently under-count a client-side rollup).",
    ],
    seeAlso: ["ib jerry admin request list", "ib jerry admin searches funnel"],
    examples: [
      "ib jerry admin request stats --from 2026-05-01",
      "ib jerry admin request stats --from 2026-01-01 --group-by month",
      "ib jerry admin request stats --from 2026-05-01 --group-by status",
    ],
  },
  {
    command: "ib jerry admin request get",
    description:
      "One request's full detail — date, customer, placing operator, worksite, m³, status, offer count, accepted/best price, plus the send-time recipient list with per-company fanout state (notified/viewed/declined/hasOffer) (GET /api/admin/jerry-requests/:id). Read `viewSource`, not `viewedAt`, to judge provider engagement: a view recorded through the tokenized preview link has no authenticated person behind it, so `viewedAt` alone counts an email-link click as a provider reading the lead (fb#638). For the offers use `ib jerry admin request offers`. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [],
    outputShape:
      "{ pumppuRequestId, status, createdAt, sentAt, expiresAt, totalM3, kayttokohde, customerAsiakasId, customerNimi, operatorName, osoite, offerCount, acceptedPriceCents, bestPriceCents, recipients: [{ asiakasId, asiakasNimi, notifiedAt, viewedAt, viewSource, viewedByPersonId, viewedByName, declinedAt, declineReason, declinedByPersonId, declinedByName, hasOffer }] }. viewSource: null = never opened · \"authenticated\" = a signed-in person opened it (viewedByPersonId/viewedByName name them) · \"link\" = opened through the tokenized preview link, nobody authenticated.",
    errors: [
      apiErr(400, "Invalid id", "pass a numeric requestId"),
      SYSADMIN_403,
      apiErr(404, "Request not found", "verify pumppuRequestId"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ["ib jerry admin request get 41"],
  },
  {
    command: "ib jerry admin request offers",
    description:
      "All offers on one request (admin view, no PII masking): offering company, contact, price, status, scheduledAt/keikka (GET /api/admin/jerry-requests/:id/offers). System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [],
    outputShape:
      "ListEnvelope<{ pumppuOfferId, providerAsiakasId, providerNimi, providerContactName, priceCents, vatPercent, status, scheduledAt, keikkaId }>",
    errors: [apiErr(400, "Invalid id", "pass a numeric requestId"), SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    examples: ["ib jerry admin request offers 41"],
  },
  {
    command: "ib jerry admin searches list",
    description:
      "Searched addresses (BetoniJerry coverage-checks) aggregated by place, with searchCount and a covered vs no_supply split — the signal for where to expand provider coverage (GET /api/admin/jerry-searches). Filters: --from/--to (createdAt), --deliverable (covered | no_supply), --search (address substring), --limit. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
      { name: "deliverable", type: "string", description: "covered (deliverable at least once) | no_supply (never covered)", allowed: [...SEARCH_DELIVERABLE] },
      { name: "search", type: "string", description: "Address substring filter" },
      { name: "limit", type: "number", default: "500", description: "Max rows (max 500)" },
    ],
    outputShape:
      "ListEnvelope<{ label, osoite, formattedAddress, placeId, lat, lng, searchCount, noSupplyCount, notGeocodedCount, deliverableEver, maxProviderCount, nearestVarikkoKm, lastSearchedAt }>",
    errors: [
      { origin: "client", exit: 4, match: "--deliverable", meaning: "--deliverable is not covered/no_supply. Rejected locally because the server ignores an unknown value and returns the UNFILTERED list — which reads as 'every address is covered'", remedy: "pass --deliverable covered or --deliverable no_supply, or omit it for all rows" },
      SYSADMIN_403,
      ...COMMON_AUTH_ERRORS,
    ],
    examples: [
      "ib jerry admin searches list --deliverable no_supply",
      "ib jerry admin searches list --from 2026-07-01 --search Vihti",
    ],
  },
  {
    command: "ib jerry admin searches funnel",
    description:
      "BetoniJerry conversion funnel over a date window (GET /api/admin/jerry-searches/funnel): top-of-funnel coverage checks, wizard step 1..5 by distinct session, claimed count, and the outcome breakdown of claimed requests by status. System-admin only.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    flags: [
      { name: "from", type: "string", description: "createdAt from (YYYY-MM-DD/today/yesterday)" },
      { name: "to", type: "string", description: "createdAt to (inclusive)" },
    ],
    outputShape:
      "{ coverageChecks: { total, deliverable, notDeliverable, notGeocoded }, wizard: { sessions, step1, step2, step3, step4, step5, claimed }, outcomes: { [status]: count } }",
    errors: [SYSADMIN_403, ...COMMON_AUTH_ERRORS],
    examples: ["ib jerry admin searches funnel --from 2026-07-01 --to 2026-07-24"],
  },
  {
    command: "ib jerry admin request expire",
    description:
      "Force-expire an open/no_supply/pending_verification request (POST /api/admin/jerry-requests/:id/expire). status → expired. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'expired' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in an expirable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request expire 41 --reason "abandoned"'],
  },
  {
    command: "ib jerry admin request cancel",
    description:
      "Cancel a non-terminal, non-accepted request (POST /api/admin/jerry-requests/:id/cancel). status → cancelled. Already cancelled/expired/accepted → 409 (an accepted request has a confirmed offer/keikka and is not cancellable here). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'cancelled' } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in a cancellable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request cancel 41 --reason "customer request"'],
  },
  {
    command: "ib jerry admin request resend",
    description:
      "Re-match providers and notify the NEW ones (POST /api/admin/jerry-requests/:id/resend). Safe to repeat: providers already on the recipient list keep their notifiedAt/viewedAt/declinedAt and are NOT re-emailed, so a resend with an unchanged match set is a no-op (notifiedCount 0). System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status: 'open' | 'no_supply', providerCount, notifiedCount } or { dryRun: true, wouldUpdate: { pumppuRequestId, status } }",
    notes: [
      "providerCount = companies matching the worksite now; notifiedCount = of those, how many were newly added and emailed.",
      "Use it to reach a provider that only just became eligible — it will not spam the ones that already ignored the request.",
    ],
    errors: [SYSADMIN_403, apiErr(409, "Wrong state", "request not in a resendable state"), ...COMMON_AUTH_ERRORS],
    examples: ['ib jerry admin request resend 41 --reason "uusi tarjoaja alueelle"'],
  },
  {
    command: "ib jerry admin request extend",
    description:
      "Extend a request's validity (POST /api/admin/jerry-requests/:id/extend). Sets expiresAt to now + --days (default 14, i.e. 2 weeks) or an absolute --until date; the new expiry must be in the future. An 'expired' request is reactivated to 'open'; open/no_supply/pending_verification keep their status (a no_supply request stays in Koko markkina, never Päättyneet). draft/cancelled/accepted → 409. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [
      { name: "days", type: "number", description: "Valid for N more days from now; mutually exclusive with --until. Omit BOTH for the backend default of 14 days" },
      { name: "until", type: "string", description: "Absolute new expiry (ISO date/datetime); mutually exclusive with --days" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true, status, expiresAt } or { dryRun: true, wouldUpdate: { pumppuRequestId, expiresAt } }",
    errors: [
      { origin: "client", exit: 4, match: "--days or --until", meaning: "--days and --until passed together", remedy: "pass exactly one, or neither for the default 14 days" },
      apiErr(400, "Bad date/days", "use a positive --days or a future --until"),
      SYSADMIN_403,
      apiErr(409, "Wrong state", "request not in an extendable state (draft/cancelled/accepted)"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin request extend 32 --days 14 --reason "reactivate"'],
  },
  {
    command: "ib jerry admin request delete",
    description:
      "Delete a DRAFT request permanently (DELETE /api/admin/jerry-requests/:id). Only status='draft' rows are deletable; a non-draft or missing id returns 404. System-admin only. Requires --reason.",
    permissions: ["isSystemAdmin"],
    tier: "developer",
    args: [{ name: "requestId", type: "number", description: "pumppuRequestId" }],
    flags: [{ name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason); REQUIRED" }],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ success: true } or { dryRun: true, wouldDelete: { pumppuRequestId } }",
    errors: [
      SYSADMIN_403,
      apiErr(404, "Not a draft / not found", "only status='draft' rows are deletable; non-draft or missing id → 404"),
      ...COMMON_AUTH_ERRORS,
    ],
    examples: ['ib jerry admin request delete 41 --reason "cleanup draft"'],
  },

  // ─── schema (10) — developer-only SQL introspection ────────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["developer access (isSystemAdmin or isDeveloper)"];
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "run `ib auth whoami`; if not a developer, `ib auth login` as a developer account (same person re-login won't grant it). Gate is server-side — a new DB flag only applies once --endpoint's backend is redeployed."),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const listFlags = [
      { name: "search", type: "string", description: "Filter object names by substring" },
      {
        name: "limit",
        type: "number",
        default: "200",
        description:
          "Max rows (max 1000). The default CAPS the catalogue — dbo holds ~240 tables and ~535 procs, so a default `procs`/`tables` read is a PARTIAL list; pass --limit 1000 whenever you intend to enumerate.",
      },
    ];
    /** Appended to every schema LIST outputShape — the cap is the trap (fb#641). */
    const truncNote =
      " `truncated: true` (with a `hint` naming the way out) means the row cap bit and this page is NOT the whole catalogue — it also prints a warning on stderr. Never conclude an object does not exist from a truncated page; re-run with --limit 1000 or --search first.";
    const invalidNameErr = apiErr(400, "Invalid name (letters/digits/underscore only)", "use the bare object name, no schema prefix");
    return [
      {
        command: "ib dev schema tables",
        description: "List dbo base tables with column counts. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'table', columnCount }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: devErrors,
        examples: ["ib dev schema tables", "ib dev schema tables --search keikka", "ib dev schema tables --limit 1000"],
      },
      {
        command: "ib dev schema table",
        description: "Columns (type, nullability, default, key), primary key, foreign keys (outbound), inbound references (tables/columns whose FK points AT this table), indexes, and attached triggers for one dbo table — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, columns:[{name,dataType,maxLength,precision,scale,nullable,default,key}], primaryKey:[…], foreignKeys:[{column,refTable,refColumn,name,disabled?,notTrusted?}], checkConstraints:[{name,column,definition,disabled?,notTrusted?}], inboundForeignKeys:[{refTable,refColumn,column}], indexes:[{name,columns,unique}], triggers:[{name,timing,events,disabled}] }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false). precision/scale are null for non-numeric types (varchar → maxLength); a DECIMAL(5,2) reports precision 5 / scale 2, an int precision 10 / scale 0. `triggers` is a SUMMARY (no T-SQL) — read a body with `ib dev schema trigger <name>`.",
        errors: [
          ...devErrors,
          invalidNameErr,
          apiErr(
            404,
            "Table not found",
            "check the name via `ib dev schema tables`. The 404 disambiguates for you: when the name exists as another object CLASS it names the command that reads it (a trigger → `ib dev schema trigger`), and when `<name>Id` is some table's PRIMARY KEY it names that table (`tuote` → `tuotteet`). So a not-found on a name you are sure of means wrong COMMAND or wrong WORD, not a typo."
          ),
        ],
        notes: [
          "ENFORCEMENT, not just existence (fb#425): `disabled` on a foreign key or CHECK means it is NOT checked on write — the constraint is inert and violating rows can land. `notTrusted` means it was re-enabled without a re-check, so existing rows may already violate it. BOTH KEYS ARE OMITTED WHEN FALSE, so their presence is the signal; a healthy table shows neither. Constraint state differs between environments — a dev-vs-prod FK failure is usually this.",
        ],
        examples: ["ib dev schema table keikka", "ib dev schema table keikka,asiakas,tyomaa"],
      },
      {
        command: "ib dev schema views",
        description: "List dbo views with column counts. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'view', columnCount }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: devErrors,
        examples: ["ib dev schema views", "ib dev schema views --limit 1000"],
      },
      {
        command: "ib dev schema view",
        description: "Columns and full definition (T-SQL) for one dbo view — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, columns:[{name,dataType,maxLength,precision,scale,nullable,default,key}], definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "View not found", "check the name via `ib dev schema views` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it (a trigger → `ib dev schema trigger`)")],
        examples: ["ib dev schema view keikkaBetoniView", "ib dev schema view keikkaBetoniView,asiakasView"],
      },
      {
        command: "ib dev schema procs",
        description: "List dbo stored procedures and functions (P/FN/TF/IF). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: listFlags,
        outputShape:
          "{ items: [{ name, type:'P'|'FN'|'TF'|'IF' }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: devErrors,
        examples: ["ib dev schema procs", "ib dev schema procs --search asiakas", "ib dev schema procs --limit 1000"],
      },
      {
        command: "ib dev schema proc",
        description: "Signature (parameters) and full definition (T-SQL) for one dbo proc/function — or several at once via a comma-separated list (read the procs you're about to CREATE OR ALTER in one call). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, type, parameters:[{name,dataType,mode}], definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "Proc/function not found", "check the name via `ib dev schema procs` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it (a trigger → `ib dev schema trigger`)")],
        examples: ["ib dev schema proc asiakas_find", "ib dev schema proc sijainti_save,sijainti_add,asiakas_sijainnit_get"],
      },
      {
        command: "ib dev schema triggers",
        description: "List dbo triggers with their parent table, timing (AFTER / INSTEAD OF), the events that fire them, and whether they are disabled. Narrow to one table with --table. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [
          ...listFlags,
          { name: "table", type: "string", description: "Only triggers whose parent table is this (exact name)" },
        ],
        outputShape:
          "{ items: [{ name, table, timing:'AFTER'|'INSTEAD OF', events:['INSERT'|'UPDATE'|'DELETE'], disabled, type:'trigger' }], nextCursor: null, count, truncated?, hint? }." + truncNote,
        errors: devErrors,
        notes: [
          "Trigger bodies carry real business logic here (keikka_after_ins_trig creates keikkaBetoni/toimitus/keikkaPerson rows), so a table's writers are not fully described by its procs alone.",
          "`ib dev schema table <name>` already lists that table's triggers in its `triggers` summary — use this command to search across tables or to filter by name.",
        ],
        examples: ["ib dev schema triggers", "ib dev schema triggers --table keikka", "ib dev schema triggers --search updateLastActive"],
      },
      {
        command: "ib dev schema trigger",
        description: "Parent table, timing, events, disabled flag, and full definition (T-SQL) for one dbo trigger — or several at once via a comma-separated list. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        args: [{ name: "name", type: "string", description: "bare dbo object name (no schema prefix); comma-separated for a batch (a,b,c)" }],
        flags: [],
        outputShape: "single name → { name, table, timing:'AFTER'|'INSTEAD OF', events:[…], disabled, definition:'<T-SQL>' }; comma-separated → { items:[{ name, found, object }], nextCursor:null, count } (missing names → found:false)",
        errors: [...devErrors, invalidNameErr, apiErr(404, "Trigger not found", "check the name via `ib dev schema triggers` — when the name DOES exist but is another object class, the 404 says so and names the command that reads it")],
        examples: ["ib dev schema trigger keikka_after_ins_trig", "ib dev schema trigger keikka_after_ins_trig,tyomaaPerson_after_ins_trig"],
      },
      {
        command: "ib dev schema dump",
        description: "Whole-schema structural map of the dbo schema (developer-gated, read-only) — all tables with column names and types, FK edges, view names, proc signatures, and trigger summaries. No proc/view/trigger bodies (use `schema proc`/`schema view`/`schema trigger` for those).",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ tables:[{name,columns}], foreignKeys:[{table,column,refTable,refColumn,disabled?,notTrusted?}], views:[{name}], procs:[{name,type,parameters}], triggers:[{name,table,timing,events,disabled}] }",
        errors: devErrors,
        notes: [
          "The FK `disabled`/`notTrusted` keys are OMITTED when false, so filtering the dump's foreignKeys for either key answers \"which constraints in the whole schema are not enforced\" in ONE call (fb#425).",
        ],
        examples: ["ib dev schema dump"],
      },
      {
        command: "ib dev schema snapshots",
        description:
          "List migration snapshot tables (the copies migrations take before they delete) with their retention state. Reports only — nothing here drops anything. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "limit", type: "number", default: "200", description: "Max rows (max 1000)" }],
        outputShape:
          "{ items: [{ name, type:'table', rows, createdAt, state:'expired'|'malformed'|'unstamped'|'stamped', dropAfter, origin, reason, daysOverdue }], nextCursor: null, count, truncated?, hint? } — ordered action-first: expired (most overdue) → malformed → unstamped → stamped." + truncNote,
        errors: devErrors,
        notes: [
          "The retention contract is an `IB_Snapshot` extended property on the table itself, so it travels with the object and dies with it. `origin` names the migration that created the snapshot; `reason` says what it holds.",
          "`unstamped` = the table LOOKS like a snapshot by name but carries no contract — detection deliberately does not rely on the naming convention, since a forgotten stamp is the failure being caught. `malformed` = a stamp with no usable date, which is worse than none: it reads as owned but can never expire.",
          "Expired never means 'drop it automatically'. A monthly `ib task` surfaces these in the morning report and a human decides — dropping a rollback path on a timer is worse than keeping a dead table.",
          "Convention, the 90-day cap and the GDPR position: puminet5api `migrations/README.md` § Snapshot tables.",
        ],
        examples: ["ib dev schema snapshots"],
      },
    ];
  })(),

  // ─── opendata (12): free/open external data — building + parcel + weather + prh ────
  {
    command: "ib opendata building",
    description:
      "Look up building-registry data for a point anywhere in Finland. The metro-area WFS providers (Helsinki/Vantaa/Espoo/HSY) are tried first for their richer per-building detail; the NATIONAL Ryhti open dataset (SYKE) is a fallback so points outside the metro area still resolve (found:true with national:true). Resolve the point from EXACTLY ONE of: --sijainti, --worksite (alias --tyomaa), --lat+--lng, or --address. --city overrides the provider (pass Ryhti to force the national source); when omitted it is derived from the source or auto-tried (Helsinki→Vantaa→Espoo) then Ryhti. Read-only; any authenticated user. Worksite resolution is tenant-scoped; sijainti is cross-tenant readable; building data itself is public.",
    auth: "any",
    flags: [
      { name: "sijainti", type: "number", description: "Resolve coordinates from a sijainti id (cross-tenant readable)" },
      { name: "worksite", type: "number", description: "Resolve coordinates from a worksite (tyomaaId); tenant-scoped" },
      { name: "tyomaa", type: "number", description: "Alias for --worksite" },
      { name: "lat", type: "number", description: "Latitude (WGS84) — pair with --lng" },
      { name: "lng", type: "number", description: "Longitude (WGS84) — pair with --lat" },
      { name: "address", type: "string", description: "Street address to geocode (e.g. 'Mannerheimintie 1, Helsinki')" },
      { name: "city", type: "string", description: "Helsinki | Vantaa | Espoo | HSY | Ryhti (override; otherwise derived/auto-tried then national Ryhti fallback)" },
    ],
    outputShape:
      "{ source:'sijainti'|'worksite'|'address'|'coords', input, coords:{lat,lng}, city|null, requestedCity|null, derivedCity|null, found:boolean, outOfArea:boolean, national:boolean, building:{ buildingId, nationalBuildingId, buildingType, floors, totalArea, completionYear, facadeMaterial, … common schema }|null }",
    errors: [
      { origin: "client", exit: 4, meaning: "No source, multiple sources, or invalid city/coords", remedy: "pass exactly one of --sijainti / --worksite / --lat+--lng / --address; city must be Helsinki|Vantaa|Espoo|HSY|Ryhti" },
      apiErr(404, "Sijainti/worksite not found (or no coordinates), or address not geocodable", "verify the id/address; a worksite must be geocoded and in your tenant"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "national:true → the building came from the national Ryhti dataset (used when the metro WFS providers miss or the point is outside the metro area). Its street/postal address is joined by proximity from the Ryhti open_address dataset (so streetNameFi/streetNumber/postalCode/postalArea are populated), but it has no utility fields, and SYKE warns its data quality varies — treat it as enrichment, not authoritative.",
      "outOfArea:true → the point is outside the Helsinki metropolitan area; with the Ryhti fallback a building may still be found (found:true, national:true). found:false with outOfArea:true means even Ryhti had no match.",
      "found:false with outOfArea:false → no building within ~50 m of the point.",
      "For building data already stored on a worksite, `ib worksite get <id> --include-building` is cheaper.",
    ],
    seeAlso: ["ib worksite get", "ib opendata weather worksite", "ib sijainti list"],
    examples: [
      "ib opendata building --worksite 1234",
      "ib opendata building --sijainti 56",
      "ib opendata building --address 'Mannerheimintie 1, Helsinki'",
      "ib opendata building --address 'Hämeenkatu 1, Tampere'",
      "ib opendata building --lat 60.1699 --lng 24.9384 --city Helsinki",
      "ib opendata building --lat 61.4978 --lng 23.7610 --city Ryhti",
    ],
  },
  {
    command: "ib opendata parcel",
    description:
      "Look up cadastral parcel (kiinteistö / palsta) data for a property or point ANYWHERE in Finland, from MML's national open Kiinteistötietojen kyselypalvelu (OGC API Features). Complements `ib opendata building`: building answers 'what is built here', parcel answers 'which registered parcel is here / what does this kiinteistötunnus cover'. Resolve from EXACTLY ONE of: --kiinteistotunnus (dashed or 14-digit), --sijainti, --worksite (alias --tyomaa), --lat+--lng, or --address. Returns the parcel polygon(s), MML presentation-form id and a computed area (m²; the open product carries no registered-area attribute). NOTE: this is the registered cadastral unit, NOT the town-plan plot with building rights (rakennusoikeus). The propertyId returned by `ib opendata building` feeds straight into --kiinteistotunnus. Read-only; any authenticated user. Worksite resolution is tenant-scoped; sijainti is cross-tenant readable; cadastral data itself is public.",
    auth: "any",
    flags: [
      { name: "kiinteistotunnus", type: "string", description: "Property identifier, dashed (092-014-0202-0001) or 14-digit (09201402020001) — direct lookup, no geocode" },
      { name: "sijainti", type: "number", description: "Resolve coordinates from a sijainti id (cross-tenant readable)" },
      { name: "worksite", type: "number", description: "Resolve coordinates from a worksite (tyomaaId); tenant-scoped" },
      { name: "tyomaa", type: "number", description: "Alias for --worksite" },
      { name: "lat", type: "number", description: "Latitude (WGS84) — pair with --lng" },
      { name: "lng", type: "number", description: "Longitude (WGS84) — pair with --lat" },
      { name: "address", type: "string", description: "Street address to geocode (e.g. 'Sarkatie 7, Vantaa')" },
      { name: "with-buildings", type: "boolean", description: "Also count buildings on the parcel via national Ryhti (permit-based, best-effort); adds buildingCount + buildings to the parcel" },
    ],
    outputShape:
      "{ source:'kiinteistotunnus'|'sijainti'|'worksite'|'address'|'coords', input, coords:{lat,lng}|null, found:boolean, parcel:{ source:'MML', kiinteistotunnus, kiinteistotunnusFormatted, municipalityNumber, parcelCount, totalAreaM2, palstat:[{ palstaId, kiinteistotunnus, kiinteistotunnusFormatted, areaM2, representativePoint:{lat,lng}|null, geometry }], buildingCount?, buildings?:[{ nationalBuildingId, usagePurpose, completionYear, status }] (only with --with-buildings) } }",
    errors: [
      { origin: "client", exit: 4, meaning: "No source, multiple sources, both kiinteistotunnus and a point, invalid kiinteistotunnus, or invalid coords", remedy: "pass exactly one of --kiinteistotunnus / --sijainti / --worksite / --lat+--lng / --address" },
      apiErr(404, "Sijainti/worksite not found (or no coordinates), or address not geocodable", "verify the id/address; a worksite must be geocoded and in your tenant"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "parcelCount / number of polygons = number of PALSTAT (separate land pieces that make up one property), NOT the number of buildings on it. Pass --with-buildings to count buildings on the parcel (national Ryhti, deduped by pysyva_rakennustunnus); use `ib opendata building` for one building's full detail.",
      "--with-buildings adds parcel.buildingCount + parcel.buildings from the national Ryhti dataset (permit-based; SYKE warns coverage/quality varies, so treat the count as best-effort). It is a best-effort enrichment: a Ryhti failure leaves buildingCount:null + buildingsError and does not fail the parcel lookup.",
      "areaM2 is COMPUTED from the parcel polygon (projected to EPSG:3067 + shoelace); MML's open 'simple' product carries no authoritative registered-area attribute, so treat it as a close approximation.",
      "kiinteistotunnusFormatted is MML's presentation form with leading zeros dropped (e.g. '92-14-202-1'); kiinteistotunnus is the 14-digit database form used by the API.",
      "found:false → MML returned no parcel for the tunnus/point (e.g. outside Finland, or an unregistered point).",
    ],
    seeAlso: ["ib opendata building", "ib worksite get", "ib sijainti list"],
    examples: [
      "ib opendata parcel --kiinteistotunnus 092-014-0202-0001",
      "ib opendata parcel --kiinteistotunnus 92742200030051 --with-buildings",
      "ib opendata parcel --address 'Sarkatie 7, Vantaa'",
      "ib opendata parcel --worksite 1234",
      "ib opendata parcel --lat 60.272 --lng 24.8062",
    ],
  },
  {
    command: "ib opendata weather forecast",
    description:
      "Single-point FMI weather forecast for a lat/lng at a given time. Coordinates must be within Finland (lat 59.5–70.1, lng 19.0–31.6). Time must be within now..+240h. Requires the company weather module (asiakasPersonSettingTypeId 18); 403 if disabled.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "time", type: "string", description: "Forecast time, ISO 8601 or 'now'" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number", remedy: "pass decimal degrees, e.g. --lat 60.1699 --lng 24.9384" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on' (admin) or contact an admin"),
      apiErr(400, "Bad coords/time", "use Finland coords and a time within now..+240h"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather forecast --lat 60.1699 --lng 24.9384 --time now",
      "ib opendata weather forecast --lat 60.1699 --lng 24.9384 --time 2026-06-09T14:00:00Z",
    ],
  },
  {
    command: "ib opendata weather day",
    description:
      "Daily aggregate weather forecast (min/max/avg temperature, wind, precipitation) for a lat/lng on a calendar date. Accepts relative date aliases: today, tomorrow, yesterday. Coordinates must be within Finland. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "date", type: "string", description: "Date (YYYY-MM-DD, or today/tomorrow/yesterday)" },
    ],
    outputShape:
      "{ date, minTemp, maxTemp, avgTemp, windSpeed, precipitation, weatherSymbol, source, coordinates }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number", remedy: "pass decimal degrees, e.g. --lat 60.17 --lng 24.94" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(400, "Bad coords/date", "use Finland coords and a valid date"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather day --lat 60.17 --lng 24.94 --date today",
      "ib opendata weather day --lat 60.17 --lng 24.94 --date 2026-06-10",
    ],
  },
  {
    command: "ib opendata weather pumping",
    description:
      "Weather analysis over a concrete-pumping window: hourly conditions for the entire duration starting at --start. The backend can correlate with a keikka via --keikka for error reporting. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "lat", type: "number", description: "Latitude (Finland 59.5–70.1)" },
      { name: "lng", type: "number", description: "Longitude (Finland 19.0–31.6)" },
      { name: "start", type: "string", description: "Pumping start time (ISO 8601 or 'now')" },
      { name: "duration", type: "number", description: "Pumping duration in minutes" },
      { name: "keikka", type: "number", description: "Keikka id (optional, for backend error correlation only)" },
    ],
    outputShape:
      "{ hourly: [{ time, temperature, windSpeed, precipitation, weatherSymbol }], summary, coordinates }",
    errors: [
      { origin: "client", exit: 4, meaning: "--lat/--lng not a number, or --duration/--keikka not a positive integer", remedy: "pass decimal degrees and whole minutes, e.g. --lat 60.17 --lng 24.94 --duration 120" },
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(400, "Bad coords/time/duration", "use Finland coords, valid ISO time, positive duration"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather pumping --lat 60.17 --lng 24.94 --start now --duration 120",
      "ib opendata weather pumping --lat 60.17 --lng 24.94 --start 2026-06-10T08:00:00Z --duration 90 --keikka 1234",
    ],
  },
  {
    command: "ib opendata weather worksite",
    description:
      "Forecast for a worksite identified by tyomaaId. The backend resolves the coordinates from the tyomaa record internally — no lat/lng needed. Use --force-refresh to bypass the cache. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "tyomaaId", type: "number", description: "tyomaaId (coordinates resolved server-side)" }],
    flags: [
      { name: "force-refresh", type: "boolean", description: "Bypass the cache and refetch from FMI" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      apiErr(404, "Tyomaa not found or has no coordinates", "check tyomaaId; ensure the worksite has been geocoded"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather worksite 1234",
      "ib opendata weather worksite 1234 --force-refresh",
    ],
  },
  {
    command: "ib opendata weather sijainti",
    description:
      "Point forecast for a sijainti (depot/plant/location): resolves the location's coordinates (GET /api/geocode/sijainti/get/:id), then calls FMI. Sijainnit are cross-tenant readable. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "sijaintiId", type: "number", description: "sijaintiId (coordinates resolved from the location)" }],
    flags: [
      { name: "time", type: "string", description: "Forecast time (ISO 8601 or 'now'; default now)" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Sijainti not found or has no coordinates", remedy: "check sijaintiId; ensure the location has a GPS pin (`ib sijainti list`)" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather sijainti 56",
      "ib opendata weather sijainti 56 --time 2026-06-30T08:00:00Z",
    ],
  },
  {
    command: "ib opendata weather keikka",
    description:
      "Forecast for a keikka: resolves the keikka's worksite (GET /api/cli/keikka/get/:id → worksite.tyomaaId) and returns the worksite forecast (POST /api/weather/tyomaa/:id). Tenant-scoped via the keikka. Requires the company weather module.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    args: [{ name: "keikkaId", type: "number", description: "keikkaId (coordinates resolved from its worksite)" }],
    flags: [
      { name: "force-refresh", type: "boolean", description: "Bypass the cache and refetch from FMI" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Keikka not found or has no worksite", remedy: "check keikkaId; the keikka must have a worksite with coordinates" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib opendata weather worksite", "ib keikka get"],
    examples: [
      "ib opendata weather keikka 9001",
      "ib opendata weather keikka 9001 --force-refresh",
    ],
  },
  {
    command: "ib opendata weather address",
    description:
      "Point forecast for a street address: geocodes the address via Google Maps (POST /api/geocode/getLatLng), then calls FMI for the forecast. Requires the company weather module. Fails with exit 5 (not-found) if the address returns ZERO_RESULTS from Google.",
    permissions: ["company weather module (asiakasPersonSettingTypeId 18)"],
    flags: [
      { name: "address", type: "string", description: "Street address (min 5 chars)" },
      { name: "time", type: "string", description: "Forecast time (ISO 8601 or 'now')" },
    ],
    outputShape:
      "{ temperature, windSpeed, precipitation, cloudCover, weatherSymbol, description, source, coordinates, forecastTime, cached? }",
    errors: [
      apiErr(403, "Weather module off or permission denied", "enable via 'ib opendata weather toggle --on'"),
      { http: 404, exit: 5, meaning: "Address not found (ZERO_RESULTS)", remedy: "try a more specific Finnish address" },
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather address --address 'Mannerheimintie 1, Helsinki' --time now",
      "ib opendata weather address --address 'Tampereen valtatie 5, Tampere' --time 2026-06-10T10:00:00Z",
    ],
  },
  {
    command: "ib opendata weather status",
    description:
      "Check whether the weather module is enabled for the active company. Does not require the weather module itself to be enabled (no circular dependency). Returns the enabled/disabled status and related settings.",
    auth: "any",
    flags: [],
    outputShape: "{ enabled: boolean, ... }",
    errors: [
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib opendata weather status"],
  },
  {
    command: "ib opendata weather toggle",
    description:
      "Enable or disable the weather module for the active company. Pass exactly one of --on or --off. Admin-scoped operation. Supports --dry-run, --idempotency-key, and --reason for audit trail.",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    flags: [
      { name: "on", type: "boolean", description: "Enable the module" },
      { name: "off", type: "boolean", description: "Disable the module" },
    ],
    outputShape: "{ success: boolean, enabled: boolean, ... }",
    errors: [
      { origin: "client", exit: 4, meaning: "Neither --on nor --off passed, or both passed", remedy: "pass exactly one of --on / --off" },
      apiErr(403, "Permission denied (admin required)", "requires admin role on the company"),
      apiErr(401, "Not authenticated", "run 'ib auth login'"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib opendata weather toggle --on --reason 'enabling for summer season'",
      "ib opendata weather toggle --off --dry-run",
    ],
  },
  {
    command: "ib opendata prh",
    description:
      "Look up a company in the Finnish business registry (PRH open data). Pass <ytunnus> for an exact business-ID lookup, or --search <name>. Read-only; any authenticated user. Re-homed from `ib customer prh` (still works as a hidden alias); customer create/update prefill from the same data via --from-prh.",
    auth: "any",
    args: [{ name: "ytunnus", type: "string", required: false, description: "business ID (XXXXXXXX-X)" }],
    flags: [
      { name: "search", type: "string", description: "Search by company name instead" },
      { name: "page", type: "number", default: "1", description: "Result page for --search" },
    ],
    outputShape:
      "by-id: { businessId, name, tradeNames, address:{street,postCode,city,full}, companyForm, status } | search: ListEnvelope<{ businessId, name, city }>",
    errors: [
      apiErr(404, "Business ID not found", "verify the Y-tunnus"),
      apiErr(400, "Invalid Y-tunnus format", "use XXXXXXXX-X"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib customer create", "ib opendata building"],
    examples: ["ib opendata prh 0145937-9", "ib opendata prh --search Betoni"],
  },

  // ─── reference (1) ───────────────────────────────────────────────────────
  {
    command: "ib reference dump",
    description:
      "Emit the full command surface as JSON for one-shot AI ingestion. The universal 401/500 error contract is hoisted to a single top-level `commonErrors` block and stripped from each spec (it applied to every command) — read `commonErrors` together with each spec's command-specific `errors`. Pass one or more domains (the token after `ib`, e.g. keikka) to narrow the commands map — STRONGLY preferred over the full surface (a one-domain dump is a fraction of the bytes). The full (no-domain) dump carries a `notice` field pointing this out. `glossary` (the term+synonyms vocabulary index) is OPT-IN via `--glossary`. `--commands-only` emits just { version, generatedAt, commonErrors, commands } for callers that already know the domain.",
    auth: "none",
    args: [
      {
        name: "domain...",
        type: "string",
        required: false,
        description:
          "Restrict the commands map to one or more domains (the token after `ib`, e.g. keikka). Multiple domains share a single primer. Unknown domain exits 4 listing valid domains.",
      },
    ],
    flags: [
      {
        name: "glossary",
        type: "boolean",
        description:
          "Include the term+synonyms vocabulary INDEX (fetched from the DB) under `glossary`. Off by default to keep the dump small; fetch definitions on demand with `ib glossary lookup <term>` / `ib glossary list`.",
      },
      {
        name: "commands-only",
        type: "boolean",
        description:
          "Emit only { version, generatedAt, commonErrors, commands } — drop the overview/topics/feedbackGuidance primer and skip the glossary fetch (no token needed). Fewer bytes per dump.",
      },
      {
        name: "lean",
        type: "boolean",
        description:
          "Drop each command's `notes`/`seeAlso` prose (KEEPS `examples`) — ~7.6k fewer tokens on the full surface. For a whole-surface scan you get what exists + how to call it; fetch the dropped caveats/cross-refs per-command via `ib <command> --help`. Composes with --commands-only and domain filters.",
      },
    ],
    outputShape:
      "{ version, generatedAt, commonErrors: CommandError[], notice?, overview, glossary, feedbackGuidance, topics, commands: { '<command>': CommandSpec } } — with --commands-only: { version, generatedAt, commonErrors, commands }; with --lean each spec drops notes/seeAlso (examples kept). `commonErrors` (401/500) applies to EVERY command and is omitted from each spec's `errors`. `notice` appears only on the full (no-domain) dump. `glossary` is the term+synonyms INDEX only and is EMPTY unless `--glossary` is passed; fetch a definition with `ib glossary lookup <term>` or all of them with `ib glossary list`.",
    errors: [
      { origin: "client", exit: 4, meaning: "Unknown domain", remedy: "run `ib commands` (no arg) to see valid domains" },
      { origin: "client", exit: 1, meaning: "I/O error", remedy: "retry; check stdout pipe" },
    ],
    examples: [
      "ib reference dump keikka",
      "ib reference dump --lean --commands-only",
      "ib reference dump --glossary",
      "ib reference dump | jq .commonErrors",
    ],
  },
  {
    command: "ib reference detail get",
    description:
      "On-demand business/AI context for one command (DB-backed via /api/cli/command-catalog); exit 5 if none",
    auth: "any",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description: "Command path after `ib` (e.g. keikka latest)",
      },
    ],
    flags: [],
    outputShape: "{ command, summary, detail, hint }. exit 5 when unknown or no detail yet.",
    errors: [
      // Two DIFFERENT origins share exit 5, and they must stay separate rows so
      // hintForError can match each: the unknown-command guard is client-side
      // (statusCode 0, matched by exit), while "no detail yet" is a real HTTP 404
      // from the catalog route (matched by http). A single http-less row left the
      // 404 case falling through to the generic hint, which wrongly blamed the
      // active company — the catalog is global, not tenant-scoped (feedback #280).
      {
        origin: "client",
        exit: 5,
        meaning: "Unknown command (client-side guard)",
        remedy: "`ib commands` / `ib reference dump` for valid paths; or `<cmd> --help`",
      },
      {
        http: 404,
        exit: 5,
        meaning: "Known command, but no detail recorded yet",
        remedy:
          "no business-context detail is recorded for this command yet — fall back to `<cmd> --help`, which is self-contained; a developer can fill the catalog entry",
      },
    ],
    examples: [
      "ib reference detail get keikka latest",
      "ib reference detail get jerry check-address",
    ],
  },
  {
    command: "ib reference detail list",
    description:
      "List command-catalog entries, optionally ordered by stalest (DB-backed)",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [
      {
        name: "stalest",
        type: "number",
        description: "Return up to N entries sorted by least-recently reviewed",
      },
      {
        name: "domain",
        type: "string",
        description: "Only commands in this ib domain (e.g. attachment) — narrows BEFORE --stalest, so the budget isn't spent on unrelated commands",
      },
      {
        name: "with-detail",
        type: "boolean",
        description: "Include each entry's full detail text (adds a `detail` field per item), folding the per-command `reference detail get` into this one call. Needs the backend deployed; on an old backend the field is simply absent.",
      },
      { name: "needs-review", type: "boolean", description: "Only rows still needing grooming: aiConfidence below the threshold (or unassessed) AND not parked, oldest-first." },
      { name: "max-confidence", type: "number", description: "Threshold for --needs-review (default 90)." },
      { name: "search", type: "string", description: "Only rows whose command PATH contains this substring (case-insensitive). Client-side, so it works without a raw DB LIKE — the discover half of `reference detail delete`." },
      { name: "orphans", type: "boolean", description: "Only ORPHAN rows: keys whose command no longer exists in the live catalogue (re-homed/renamed leftovers). Same set as `reference detail lint`, but streamed as normal list rows so you can pipe → `delete`. Compose with --search to narrow." },
      { name: "limit", type: "number", description: "Return at most N rows. A client-side payload CAP applied LAST (after --search/--orphans), not a pager — there is no cursor, so the rows past N are simply not returned and `truncated: true` says so." },
    ],
    outputShape: "{ items: [{ command, summary, lastReviewed, runs, aiConfidence, needsHumanReview, detail? }], count, truncated? } — `detail` present only with --with-detail. --search/--orphans filter client-side and recompute count; `truncated: true` appears only when --limit actually cut rows.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" },
      { origin: "client", exit: 4, match: "unknown domain", meaning: "Unknown --domain", remedy: "`ib commands` for valid domains" },
      { origin: "client", exit: 4, match: ["--limit", "--stalest"], meaning: "--limit / --stalest is not an integer >= 1", remedy: "pass a positive integer; a bad cap is rejected rather than dropped, which would silently return the WHOLE catalog" },
    ],
    notes: [
      "--search and --orphans are client-side post-filters (no backend deploy needed): the full catalog is fetched, then narrowed locally.",
      "NARROWING, not paging, is the model here: the backend returns the whole catalog in one shot and there is no cursor. Reach for --domain/--search/--needs-review/--stalest to ask a smaller question; --limit only caps the payload you get back (useful against --with-detail, which is ~154 large rows).",
      "--stalest and --limit are different caps: --stalest caps the SERVER page and orders it least-recently-reviewed first, --limit caps client-side AFTER the filters. Passing both gives you at most --limit of the stalest --stalest.",
      "Because --stalest caps the server page first, run --orphans WITHOUT --stalest for a full-catalog orphan scan (with --stalest it only scans that page).",
      "--orphans returns the same set as `reference detail lint` but as plain list rows, so `reference detail list --orphans` → `reference detail delete <key>` is a self-contained discover→prune workflow for an MCP/exec-only caller.",
    ],
    examples: [
      "ib reference detail list",
      "ib reference detail list --stalest 20",
      "ib reference detail list --stalest 10 --domain attachment",
      "ib reference detail list --stalest 10 --domain attachment --with-detail",
      "ib reference detail list --needs-review --max-confidence 90",
      "ib reference detail list --search 'dev bug'",
      "ib reference detail list --orphans",
      "ib reference detail list --with-detail --limit 20",
    ],
  },
  {
    command: "ib reference detail set",
    description:
      "Write summary and/or detail for one command in the command-catalog (developer only)",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "server",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description: "Command path after `ib` (e.g. keikka latest)",
      },
    ],
    flags: [
      {
        name: "summary",
        type: "string",
        description: "Short one-line summary stored in the catalog (≤160 chars, server-enforced)",
      },
      {
        name: "detail",
        type: "string",
        description: "Full markdown business-context detail (≤2000 chars, server-enforced). Don't recap flags/exit codes — those already render in `--help` from the spec; spend the budget on business context only found here.",
      },
      { name: "ai-confidence", type: "number", description: "Self-assessed completeness/correctness 0–100 (groom rubric). Omit on a human edit to reset the score." },
      { name: "needs-human-review", type: "boolean", description: "Park the row for a human (excludes it from --needs-review); set with a low --ai-confidence when blocked." },
      { name: "field", type: "string", description: "Edit-mode target field: summary | detail (default detail)" },
      { name: "replace", type: "string", description: "Edit mode: replace this literal text in the target field (exactly once unless --all)" },
      { name: "with", type: "string", description: 'Replacement for --replace (empty deletes the matched text; ' + clearHint("--with") + ")" },
      { name: "append", type: "string", description: "Edit mode: append text to the target field (verbatim)" },
      { name: "prepend", type: "string", description: "Edit mode: prepend text to the target field (verbatim)" },
      { name: "all", type: "boolean", description: "With --replace: substitute every occurrence" },
      { name: "from-json", type: "string", description: "Read the content fields from a JSON object file (or - for stdin); argv-safe route for prose containing Finnish ä/ö or an em-dash. Accepts summary, detail, aiConfidence, field, replace, with, append, prepend. Explicit flags outrank the file; unknown or wrong-typed keys exit 4." },
    ],
    outputShape: "{ command, runs, … } (backend response) | plain --dry-run: {dryRun:true, wouldSave:{command, exists, writes:{summaryChars?, detailChars?}, aiConfidence, needsHumanReview}, validation} | edit-mode --dry-run: {dryRun:true, command, field, matchCount?, addedLines, removedLines, sameContent, unified}",
    notes: [
      "--dry-run has two resolutions. EDIT mode (--replace/--append/--prepend) resolves CLIENT-side and never PUTs — safe on any backend. A plain --summary/--detail --dry-run is SERVER-side (X-Dry-Run) and DEPLOY-GATED: the PUT handler ignored the header until puminet5api shipped the wouldSave branch, so against an older backend a plain --dry-run WRITES FOR REAL and overwrites the entry (fb#286). Until that backend deploys, preview a full-field rewrite with `reference detail get` first, or use edit mode.",
      "Caps are validated BEFORE the dry-run branch, so an over-cap payload still exits 4 under --dry-run rather than reporting a would-be write.",
      "The save proc COALESCEs the CONTENT fields — an omitted --summary/--detail keeps its current value (" + clearHint("--summary") + "), which is why the dry-run's `writes` lists only the fields you sent. aiConfidence/needsHumanReview are DIRECT-assigned: omitting them RESETS the score and un-parks the row for the grooming routine.",
      "PASS PROSE VIA --from-json, NOT argv, whenever it contains a non-ASCII character (fb#613). Windows PowerShell reinterprets UTF-8 native arguments as latin1, so `Ylijäämäbetonin` is stored as `YlijÃ¤Ã¤mÃ¤betonin` while the call exits 0 and echoes a success payload. The corruption is invisible here in a way it is not elsewhere: this catalog is served to AI agents as authoritative, lives outside git, and nothing diffs or lints it. --needs-human-review and --all take no value, so they stay on argv alongside --from-json and are deliberately NOT accepted as JSON keys.",
    ],
    errors: [
      {
        origin: "client",
        exit: 5,
        meaning: "Unknown command",
        remedy: "`ib commands` for valid paths",
      },
      {
        http: 400,
        exit: 4,
        meaning: "summary >160 or detail >2000 chars (the message names the submitted length)",
        remedy: "Trim to the cap — cut any flag/exit-code recap first (it already renders in `--help`), keep the business context",
      },
    ],
    examples: [
      "ib reference detail set keikka list --summary 'Lists delivery orders' --reason 'initial fill'",
      "ib reference detail set keikka list --detail '## Keikka list\\nReturns ...' --reason 'update'",
      "ib reference detail set keikka list --replace '14 latest' --with '20 latest' --reason 'fix count' --dry-run",
      "ib reference detail set sijainti types --from-json ./detail.json --reason 'refresh catalog'",
    ],
  },
  {
    command: "ib reference detail delete",
    description:
      "Delete one command-catalog row by its exact key — prunes orphans of re-homed/removed commands (developer only)",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description:
          "The exact stored command key after `ib` (e.g. ai conversation). Unlike get/set this is NOT validated against the live catalogue — that is precisely what lets you remove an orphan whose command no longer exists.",
      },
    ],
    flags: [],
    outputShape:
      "{ deleted } (rows removed, 0 or 1 — idempotent) | --dry-run: { dryRun:true, wouldDelete:{ command, exists }, validation }",
    errors: [
      apiErr(403, "Not a developer", "Requires isDeveloper / isSystemAdmin (server-enforced)"),
      { origin: "client", exit: 4, meaning: "Missing --reason on a real delete, or empty command path", remedy: "Pass --reason (or --dry-run to preview) and a command path" },
    ],
    examples: [
      "ib reference detail delete ai conversation --dry-run",
      "ib reference detail delete ai conversation --reason 'orphan: ai domain re-homed under dev'",
    ],
  },
  {
    command: "ib reference detail lint",
    description:
      "Audit the command-catalog for orphan rows — keys with no live command (re-homed/renamed leftovers); --strict for CI (developer only)",
    tier: "developer",
    auth: "any",
    flags: [
      { name: "strict", type: "boolean", description: "Exit 1 if any orphan row exists (for CI)" },
    ],
    outputShape:
      "{ items: [{ command, severity:'warn', kind:'orphan', summary, hint }], count } — one finding per catalog key with no live command",
    errors: [
      { origin: "client", exit: 1, meaning: "--strict and orphan rows found", remedy: "Prune each with `ib reference detail delete <key> --reason <r>`, or seed the re-homed command" },
      apiErr(403, "Not a developer", "Requires isDeveloper / isSystemAdmin (server-enforced)"),
    ],
    notes: [
      "Read-only: one GET of the whole catalog plus a local diff against the live command specs. The class behind fb#73 (`ib customer prh` re-homed to `ib opendata prh`).",
    ],
    seeAlso: ["ib reference detail delete", "ib reference detail list"],
    examples: ["ib reference detail lint", "ib reference detail lint --strict"],
  },
  {
    command: "ib commands",
    description:
      "Offline command discovery from the spec catalogue. No args = compact DOMAIN INDEX (~5 KB: every domain with leaf count, glossary blurb, runnable command paths). A domain arg, a filter flag, or --all returns the flat per-command list { command, description, permissions, isWrite }. Lighter than `ib reference dump` (the full surface). No auth, no network.",
    auth: "none",
    args: [
      {
        name: "domain",
        type: "string",
        required: false,
        description:
          "Only commands in this domain (the token after `ib`, e.g. keikka, jerry). Unknown domain exits 4 listing valid domains.",
      },
    ],
    flags: [
      {
        name: "mutations",
        type: "boolean",
        description: "Only commands that write (carry write-safety flags)",
      },
      {
        name: "reads",
        type: "boolean",
        description: "Only read-only commands (no writes)",
      },
      {
        name: "permission",
        type: "string",
        description:
          "Only commands whose required permissions contain this substring",
      },
      {
        name: "all",
        type: "boolean",
        description:
          "Full flat list of every command (~43 KB at 149 leaves). Default (no args) is the domain index.",
      },
    ],
    outputShape:
      "no args: { hint, items:[{ domain, count, description|null, commands:[\"keikka list\", ...] }], nextCursor:null, count } (domain index) | with <domain> / --all / filters: { items: [{ command, description, permissions: string[], isWrite: boolean }], nextCursor: null, count }",
    errors: [
      { origin: "client", exit: 4, match: "mutually exclusive", meaning: "Bad flag combo", remedy: "--mutations and --reads are mutually exclusive" },
      { origin: "client", exit: 4, match: "unknown domain", meaning: "Unknown domain", remedy: "run `ib commands` (no arg) to see valid domains" },
    ],
    examples: [
      "ib commands",
      "ib commands keikka",
      "ib commands --all",
      "ib commands --mutations",
      "ib commands --reads",
      "ib commands --permission auth.page.vehicle",
      "ib commands --mutations | jq '.items[].command'",
    ],
  },

  // ─── version (1) ─────────────────────────────────────────────────────────
  {
    command: "ib version",
    description:
      "Show the local CLI version AND the deployed iB version at the active endpoint (server commit SHA + slot). Unauthenticated — works logged out, against any --endpoint. The whole deployable iB surface (the /api/cli routes + the vendored CLI) ships inside puminet5api, so the server `commit` is the single source of truth for which build is live; it changes on every deployed commit, letting you tell staging from prod without manual version bumps.",
    auth: "none",
    flags: [
      {
        name: "endpoint",
        type: "url",
        default: "active profile, else https://api.ibetoni.fi",
        description: "Which deployment to query (global flag)",
      },
    ],
    outputShape:
      "{ cli, endpoint, reachable, server: { app, version, commit, release, slot } | null, error? }",
    errors: [
      { origin: "client", exit: 7, meaning: "Endpoint unreachable", remedy: "check --endpoint / network; the report (cli version + error) still prints" },
    ],
    examples: [
      "ib version",
      "ib version --endpoint https://api.ibetoni.fi",
      "ib version --endpoint https://api-staging.ibetoni.fi",
    ],
  },

  // ─── doctor (1) ──────────────────────────────────────────────────────────
  {
    command: "ib doctor",
    description:
      "Aggregated 'is my setup working' health check, and the first-contact orientation for MCP / `/api/cli/exec` callers (where the `auth` group — incl. `auth whoami` — is denied). Derives identity + tier + switchable companies from the active JWT (works for both file- and IB_TOKEN-sessions), reports token expiry, pings the public /api/version for connectivity + which build is live, and does ONE authenticated read to prove the token is accepted by this endpoint. Read-only. Exits 1 when the aggregate `ok` is false.",
    auth: "any",
    flags: [],
    outputShape:
      "{ ok:boolean, cli, endpoint, readOnly, auth:{ personId, email, tier:'developer'|'admin'|'standard', ownerAsiakasId, ownerAsiakasName, companies:{ asiakasId, roles }[], issuedFor, tokenExp, tokenExpired, impersonating?:{actorPersonId,sessionId} }, connectivity:VersionReport, authProbe:{ ok, status?, error? } } — `tier` = capability/discovery gate; `companies` = `company switch` targets; `impersonating` present only when the token acts as another person.",
    errors: [
      { origin: "client", exit: 1, meaning: "Not healthy", remedy: "inspect connectivity / authProbe / tokenExpired in the report" },
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
    ],
    examples: ["ib doctor", "ib doctor --endpoint https://api-staging.ibetoni.fi"],
  },
  // ─── inbox (1) ───────────────────────────────────────────────────────────
  {
    command: "ib dev inbox",
    description:
      "Aggregated operator inbox: counts of every open/incomplete signal (deploy-pending changelog, unresolved feedback, open support, staged legal drafts, glossary misses, live no_supply tarjouspyynnot) plus a `needsYou` headline",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "details", type: "boolean", description: "Include slimmed top-items per signal, not just counts" },
    ],
    outputShape:
      "{ generatedAt, needsYou, changelog:{ pending, deployPending, maxBumpLevel }, feedback:{ open, reviewed, byKind:{ open, reviewed } }, support:{ open, truncated }, legal:{ drafts }, glossary:{ misses }, jerry:{ noSupplyLive, noSupplyExpired } } — with --details each signal also carries an `items` array (feedback.items splits into { open, reviewed }; each reviewed item also carries { readyToClose, activeVersion, activatedAt }; jerry.items carry an `expired` flag).",
    errors: authErrors(
      apiErr(403, "Developer access required", "inbox is developer-gated; use a developer/sysadmin token")
    ),
    notes: ["Deploy-gated: 404 until the backend ships GET /api/cli/inbox."],
    examples: ["ib dev inbox", "ib dev inbox --details"],
  },
  // ─── impersonation (2) ───────────────────────────────────────────────────
  {
    command: "ib dev impersonation sessions",
    description:
      "Reconstructed impersonation sessions from the personLog audit trail (typeId 30 start / 31 end / 32 extend), joined on sessionId into one row per session: actor, target, reason, ip, start/end time, extendCount, endReason (manual|timeout|error|logout), durationSeconds, and active. Answers 'did endReason=logout rows land in prod?' without hand-written SQL. Developer-only — the data includes IPs. Read-only.",
    permissions: ["developer access (isSystemAdmin or isDeveloper)"],
    tier: "developer",
    flags: [
      { name: "actor", type: "number", description: "Only sessions run BY this actor personId" },
      { name: "target", type: "number", description: "Only sessions run AS this target personId" },
      { name: "end-reason", type: "string", description: "Filter by endReason (manual|timeout|error|logout); implies ended" },
      { name: "active", type: "boolean", description: "Only still-open sessions (no end row)" },
      { name: "limit", type: "number", default: "100", description: "Max sessions (capped at 1000)" },
    ],
    outputShape:
      "{ items:[{ sessionId, actorPersonId, targetPersonId, reason, ip, userAgent, startTime, extendCount, lastExtendTime, endTime, endReason, durationSeconds, active }], nextCursor, count, truncated } — sorted startTime desc, 90-day window.",
    errors: [
      apiErr(500, "Backend error", "retry with --verbose"),
      ...permErrors("developer access (isSystemAdmin or isDeveloper)"),
    ],
    notes: [
      "Developer-gated server-side and hidden from non-developer discovery.",
      "Sessions are reconstructed from personLog 30/31/32 (personLog.personId is always the actor). Deploy-gated: no-op until the puminet5api backend ships GET /api/cli/impersonation-sessions.",
    ],
    seeAlso: ["ib person activity", "ib dev impersonation grants"],
    examples: [
      "ib dev impersonation sessions",
      "ib dev impersonation sessions --end-reason logout",
      "ib dev impersonation sessions --target 63 --active",
    ],
  },
  {
    command: "ib dev impersonation grants",
    description:
      "Standing impersonation grants for one person — who may impersonate whom (outbound = grants where the person is grantee, inbound = grants where the person is target). Surfaces the existing GET /api/persons/:id/impersonation-grants. Read-only.",
    permissions: ["developer access (isSystemAdmin or isDeveloper)"],
    tier: "developer",
    args: [{ name: "personId", type: "number", description: "person.personId" }],
    flags: [],
    outputShape:
      "{ outbound:[{ personImpersonationGrantId, granteePersonId, targetPersonId, grantedByPersonId, grantedAt, notes, targetName, targetCompanyName }], inbound:[{ ...granteeName, granteeCompanyName }] }",
    errors: [
      apiErr(400, "personId is not a positive integer", "pass a numeric personId"),
      ...permErrors("developer access (isSystemAdmin or isDeveloper)"),
    ],
    notes: ["The backend route additionally allows self and same-company reads; discovery is hidden below developer tier as defense-in-depth."],
    seeAlso: ["ib dev impersonation sessions"],
    examples: ["ib dev impersonation grants 63"],
  },
  // ─── db-target (2) ───────────────────────────────────────────────────────
  // Both leaves hit one loopback-only route, so they share its 404 and the
  // local-auth trap rather than restating them.
  ...((): CommandSpec[] => {
    const loopback404 = apiErr(
      404,
      "Not found — this route is NOT deployed anywhere",
      "you are not talking to a local backend; it is loopback-only and 404s in production. Never read this as 'no such command'. Pass --endpoint http://127.0.0.1:8080"
    );
    const LOCAL_AUTH_REMEDY =
      "stored credentials are minted by the DEPLOYED API and a local backend verifies with its own JWT_KEY, so `ib auth login` will NOT help — it authenticates against production. Use IB_TOKEN=$(node utils/test/mint-local-token.js <personId>) from puminet5api.";
    const LOCAL_AUTH_NOTE = `AUTH against a local backend: ${LOCAL_AUTH_REMEDY}`;
    return [
  {
    command: "ib dev db-target show",
    description:
      "Which SQL database the LOCAL backend is talking to (dev or prod), with the server/database it resolved. Local development only: the route is loopback-gated and 404s on every deployed backend, so pass --endpoint http://127.0.0.1:8080. Answers the question the DbTargetChip in the puminet4 header answers, without opening a browser. Use --expect in scripts to fail closed BEFORE writing.",
    auth: "any",
    flags: [
      { name: "expect", type: "string", description: "Exit 1 if the live target is not this (dev|prod)" },
    ],
    outputShape:
      "{ target, targets[], switchable, server, database, missing[], complete } — plus { expected, matches } when --expect is passed. NOTE the two status fields describe DIFFERENT targets: `complete` is whether the CURRENT target's env vars all resolve, while `missing` lists the vars absent for the target you would switch TO. So { target:'dev', missing:['PROD_SQL_PASSWORD'], complete:true } means dev is fine and prod is not configured.",
    errors: [
      loopback404,
      apiErr(401, "Token rejected by the local backend", LOCAL_AUTH_REMEDY),
      {
        origin: "client",
        exit: 1,
        meaning: "--expect did not match the live target",
        remedy: "the JSON on stdout carries the real target; switch with `ib dev db-target set <target> --confirm`",
      },
    ],
    notes: [
      "A local backend can be repointed at PRODUCTION, in which case every local write is a real write (feedback #430).",
      LOCAL_AUTH_NOTE,
    ],
    seeAlso: ["ib dev db-target set"],
    examples: [
      "ib dev db-target show --endpoint http://127.0.0.1:8080",
      "ib dev db-target show --expect dev --endpoint http://127.0.0.1:8080",
    ],
  },
  {
    command: "ib dev db-target set",
    description:
      "Repoint the local backend at dev or prod. Previews unless --confirm (nothing is sent without it). On success the backend flushes the whole two-tier cache, because it holds the OUTGOING database's rows; a failed switch reverts and reports validation rather than success.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    args: [{ name: "target", type: "string", description: "dev | prod" }],
    flags: [{ name: "confirm", type: "boolean", description: "Execute the switch (default is a preview)" }],
    outputShape:
      "preview: { dryRun:true, from, to, wouldFlushCache, hint } — wouldFlushCache is false when you are already on that target, because the backend flushes only on a real change | execute: the same shape as `db-target show`, plus { changed }.",
    errors: [
      loopback404,
      apiErr(401, "Token rejected by the local backend", LOCAL_AUTH_REMEDY),
      apiErr(400, "Unknown target, or the switch failed and was reverted", "target must be dev|prod; a revert means nothing changed"),
      apiErr(403, "Developer role required", "the GET is open to any logged-in caller; only the switch needs developer"),
    ],
    notes: [
      "Switching to prod makes every subsequent local write a REAL write. Preview first; the preview names the target you are moving to.",
      LOCAL_AUTH_NOTE,
    ],
    seeAlso: ["ib dev db-target show"],
    examples: ["ib dev db-target set dev --endpoint http://127.0.0.1:8080", "ib dev db-target set dev --confirm --endpoint http://127.0.0.1:8080"],
  },
    ];
  })(),
  // ─── email-health (1) ────────────────────────────────────────────────────
  {
    command: "ib dev email-health",
    description:
      "Account-wide deliverability watch for our SendGrid sender (noreply@ibetoni.fi), read from our own webhook event log — daily volume, deferral rate, hard failures, and WHICH addresses the volume went to. Distinct from `ib jerry email-activity`: that one asks SendGrid's API about the betonijerry.fi domain and needs the read-only diagnostic key; this one needs no key and is the only view that shows recipient CONCENTRATION, which is what an internal notification firehose looks like.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [{ name: "days", type: "number", default: "7", description: "Window in days (1..90)" }],
    outputShape:
      "{ days, checkedAt, coverage:{ oldestEvent, newestEvent, daysWithData }, totals:{ processed, delivered, deferredEvents, deferredMessages, failed, spam }, daily:[{ date, processed, delivered, deferredEvents, deferredMessages, failed, spam }], recipients:[{ email, processed, deferredEvents, failed, sharePct }] (top 10 by volume), verdict:{ healthy, flags:[{ code, severity, detail }] } } — read `verdict.healthy` for the one-bit answer. Flag codes: deferral-rate | single-recipient-share | volume-spike | failure-rate | spam-rate.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(404, "Route not deployed yet", "the backend half is deploy-gated — deploy puminet5api first"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "deferredMessages, NOT deferredEvents, is the number of throttled sends: SendGrid re-emits `deferred` on every retry of the SAME message, so events over-count (fb#575 saw 19 events from 12 messages).",
      "coverage.oldestEvent bounds what the window can possibly show — the log is young, so a --days 30 request can silently cover far fewer days. A quiet report is not proof of a quiet month.",
      "A deferral is transient and the mail still arrives, which is why the deploy health check ignores it. The RATE is the signal: 421 4.7.28 is the polite warning that precedes real blocking.",
    ],
    seeAlso: ["ib jerry email-activity", "ib dev email-delivery"],
    examples: ["ib dev email-health", "ib dev email-health --days 30 --pretty"],
  },
  // ─── email-delivery (1) ──────────────────────────────────────────────────
  {
    command: "ib dev email-delivery",
    description:
      "What our SendGrid event log knows about ONE recipient address, or ONE message — the per-recipient half of `ib dev email-health`. Answers \"did this customer actually get it?\" from the authoritative record of every send (tarjouspyyntö fanout, offers, invoices, support, registration), instead of guessing or opening the SendGrid dashboard by hand.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "address", type: "string", required: false, description: "Recipient email address (omit when using --message)" }],
    flags: [
      { name: "message", type: "string", description: "Look up one message's event history by sg_message_id instead of an address" },
      { name: "limit", type: "number", default: "50", description: "Max recent events for an address (1..200)" },
    ],
    outputShape:
      "Address form: { email, verdict: \"delivering\"|\"pending\"|\"failing\"|\"no-data\", lastEventAt, lastDeliveredAt, lastFailureAt, lastFailure:{ event, reason, at }|null, events:[{ id, receivedTime, event, sg_message_id, category, reason, response, sg_template_id, sg_template_name }], eventCount, truncated, coverage:{ oldestEvent, newestEvent, totalEvents } }. Message form: { sgMessageId, found, recipients[], categories[], events[], eventCount, coverage }.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not logged in", remedy: "ib auth login (or set IB_TOKEN)" },
      { origin: "client", exit: 4, meaning: "No target, or both an address and --message", remedy: "pass exactly one: an address positional OR --message <sgMessageId>" },
      apiErr(401, "Token expired or invalid", "ib auth refresh (IB_TOKEN sessions: mint a fresh JWT)"),
      apiErr(403, "Developer/sysadmin only (server-enforced)", "use a developer account token"),
      apiErr(404, "Route not deployed yet", "the backend half is deploy-gated — deploy puminet5api first"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "`verdict: \"no-data\"` means NO EVIDENCE, not a failure. The event log only starts 2026-08-07, so an address with no rows was never observed either way — always read `coverage` before concluding anything. Treating absence as failure is exactly the fb#506 mistake: a Jerry provider was declared unreachable on suppression-list membership while this log showed the same message delivered one second later.",
      "`failing` means a hard failure (bounce/blocked/dropped/spamreport) that NO later delivery superseded. A `deferred` event is deliberately not a failure — it is a transient retry (Gmail's 421 4.7.28), and SendGrid retries on its own.",
      "`category` names the code path that sent the message (fb#602) — e.g. jerry-provider-request, password-reset, mass-campaign, dev-test. It is NULL on anything sent before that shipped, so an old event says nothing about which feature sent it.",
      "`verdict: \"pending\"` means events exist but NOTHING has come back yet — no delivery, and no unsuperseded failure. Repeated `deferred` events land here, and that is the signal worth acting on: it is the fb#575 Gmail-throttling shape (`421 4.7.28`). Do NOT read it as healthy; `delivering` requires an actual delivery event, not merely the absence of a failure.",
      "The message form accepts EITHER spelling of the id. What the log stores is the full `<base>.<suffix>` form, and every event of one message carries the SAME one — the suffix is per-message, not per-event. So the base id from a send result matches by prefix, the stored id matches exactly, and both return the whole history.",
    ],
    seeAlso: ["ib dev email-health", "ib jerry email-activity"],
    examples: [
      "ib dev email-delivery sami@nr-urakointi.fi",
      "ib dev email-delivery asiakas@example.fi --limit 10 --pretty",
      "ib dev email-delivery --message 142d9f3f351.7618.254f56",
    ],
  },
  // ─── feedback (5) ────────────────────────────────────────────────────────
  // NOTE on classification: feedback create/resolve carry custom write semantics
  // (meta-exempt create, client-side --dry-run, no idempotency/reason), so they
  // keep writeFlags:false — the standard write-safety block would mis-document
  // them. mutates:true is set explicitly so `ib commands --mutations` picks them
  // up and `--reads` excludes them despite writeFlags:false.
  {
    command: "ib dev feedback create",
    aliases: ["ib dev feedback add"],
    description:
      "File a CLI improvement proposal or trouble report. AI users: file this PROACTIVELY and IMMEDIATELY (no need to ask the user) whenever you hit an error or unexpected exit code, had to try several strategies because the help/docs were unclear/missing/wrong, found something confusing or harder than expected, could not find a command for something the user clearly needs (a capability gap), or saw an inconsistency between commands. Stored quietly server-side (no GitHub issue, no spam to you or the user — distinct from bug reports; the maintainer gets a private heads-up email) for later developer triage. Sent as a META request, so it is EXEMPT from the read-only write-lock: you can file feedback even with --read-only / IB_READ_ONLY active. --dry-run resolves client-side (prints the payload, never sends).",
    auth: "any",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "description", type: "string", description: "freetext description of the friction, gap, or bug" }],
    flags: [
      { name: "description", type: "string", description: "Alias for the positional description; if both are passed, they must match" },
      { name: "body", type: "string", description: "Alias for --description (free text — NOT the raw-JSON --body of the entity update commands); if several are passed, they must match" },
      { name: "title", type: "string", description: "Optional title, folded into the description as its first line (feedback rows have no stored title column). Alone it becomes the whole description." },
      { name: "kind", type: "string", default: "improvement", description: "improvement (CLI UX friction) | bug (CLI defect) | idea (new-capability proposal) | legal (legal-document change/draft proposal). STRICT: an unknown value exits 4 (it used to fall back to improvement, which mis-triaged bug reports silently — feedback #369)", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", default: "cli", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — which product surface this targets (routing key for triage; orthogonal to --kind; impeccable = auto-piped design-hook findings)", allowed: [...FEEDBACK_SCOPES] },
      { name: "command", type: "string", description: "The ib command/argv that triggered the friction" },
      { name: "error", type: "string", description: "Error message you hit, if any" },
      { name: "severity", type: "string", description: "critical | major | minor | cosmetic — optional triage weight, most useful with --kind bug. NOT high|medium|low (the issue-tracker vocabulary most tooling uses): map high→major, medium→minor, low→cosmetic. Unknown exits 4", allowed: [...FEEDBACK_SEVERITIES] },
      { name: "complexity", type: "number", description: "1-5 agent-triage estimate (orthogonal to --severity): 1 simple+autonomous · 2 simple+wants-input · 3 complex+autonomous · 4 complex+needs-user · 5 very-complex+needs-user & heavier model. Lets a batch-fix agent pull `list --max-complexity 3`. See `ib help complexity`." },
      { name: "from-json", type: "string", description: "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Keys: description (or body), title, kind, scope, command, error, severity, complexity. The READ shape's `errorText` is also accepted for `error`, so a stored feedback row can template the file. An unknown or wrong-typed key exits 4 (never silently dropped)." },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape:
      "{ feedbackId } on success (HTTP 201). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, match: ["is required", "must be one of", "must be an integer"], meaning: "Validation", remedy: "description is required; all three enums are STRICT — an unknown value exits 4 and is never rewritten: --kind must be improvement|bug|idea|legal, --scope must be cli|app|jerry|bsg2|workspace|security|ops|impeccable|other, --severity (when given) must be critical|major|minor|cosmetic (NOT the high|medium|low vocabulary — high≈major, medium≈minor, low≈cosmetic); --complexity, when given, must be an integer 1-5. The message names the closest valid value when there is one" },
      { origin: "client", exit: 4, match: "too many arguments", meaning: "too many arguments — the shell split the description on its inner double-quotes (typical on Windows PowerShell)", remedy: "Pass the report via --from-json <file|-> instead of argv" },
      { origin: "client", exit: 4, match: "--from-json", meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key", remedy: "Check the path; the root must be an object and every key an accepted field name (the error lists them)" },
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "You can pass the description positionally or as its --description/--body aliases; if you pass more than one, they must match. Here --body is FREE TEXT, unlike the raw-JSON --body on the entity update commands.",
      "gh-issue-style invocation works: `feedback add --title X --description Y` — `add` aliases `create`, and --title is prepended to the description as its first line (blank line between). Feedback rows store only a description, so the title is a formatting convenience, not a separate field.",
      'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev feedback create --kind bug -- "--pretty output too wide". Everything after `--` is taken as positional text.',
      "SHELL QUOTING (fb#299): a report body (and --command/--error) is exactly the text most likely to carry inner double-quotes, which Windows PowerShell splits on — pass long or quote-bearing reports via --from-json <file|->; see `ib help shell-quoting`.",
      "When invoked by the betoni.online /ai assistant, the originating conversation id is auto-attached as context.conversationId (via the IB_CONVERSATION_ID env var the /ai loop injects) — a developer can then read the full conversation with `ib dev ai conversation <id>`. Manual CLI use does not set it.",
    ],
    examples: [
      'ib dev feedback create "schema table output should include row counts"',
      'ib dev feedback create --description "schema table output should include row counts"',
      'ib dev feedback create --body "gh-style --body works as a --description alias"',
      'ib dev feedback add --title "Row counts missing" --description "schema table output should include row counts"',
      'ib dev feedback create "keikka list --pvm rejected my date" --kind bug --command "keikka list --pvm 1.6." --error "invalid date format"',
      'ib dev feedback create "ib customer search --email" --kind idea --dry-run',
      'ib dev feedback create "TOS 2.0 lacks a clause covering the AI assistant features; draft update suggested" --kind legal',
      'ib dev feedback create "Jerry inbox should show boom length on request cards" --scope jerry --kind idea',
      'ib dev feedback create "keikka editor throws on save" --kind bug --severity major',
      "ib dev feedback create --from-json ./report.json",
      "ib dev feedback create --from-json ./report.json --kind bug",
      'ib dev feedback create "add row counts to schema table output" --kind idea --complexity 2',
    ],
  },
  {
    command: "ib dev feedback list",
    description:
      "List filed feedback for triage. Developer-only (isSystemAdmin / isDeveloper). Newest first, paginated (default 50, cap 200). By DEFAULT returns only active items (status open + reviewed) — closed items (applied/dismissed) are hidden; pass --all for every status, or --status to name specific ones.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: "open | reviewed | applied | dismissed, or a comma-separated list (e.g. open,reviewed)", allowed: [...FEEDBACK_STATUSES] },
      { name: "unresolved", type: "boolean", description: "Shortcut for --status open,reviewed (un-closed items) — same as the default; mutually exclusive with --status/--all" },
      { name: "all", type: "boolean", description: "Include every status (open,reviewed,applied,dismissed); overrides the open+reviewed default; mutually exclusive with --status/--unresolved" },
      { name: "kind", type: "string", description: "improvement | bug | idea | legal", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other", allowed: [...FEEDBACK_SCOPES] },
      { name: "search", type: "string", description: "Substring match over description/command/resolution/errorText (deploy-gated)" },
      { name: "complexity", type: "string", description: "Only items with this exact complexity 1-5, or `none` for the rows with NO estimate at all (deploy-gated). ⚠ A NUMERIC value EXCLUDES unestimated rows, which is most of the table — absent means unestimated, not complex; `--complexity none` is how you select exactly that set for a backfill pass (fb#535)." },
      { name: "max-complexity", type: "number", description: "Only items with complexity <= n — the autonomously-workable slice a batch-fix agent pulls (deploy-gated). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex; use `--complexity none` to find those." },
      { name: "oldest", type: "boolean", description: "Oldest-first (createdAt ASC) — FIFO drain order so the triage loop clears the backlog before newer arrivals; default is newest-first" },
      { name: "limit", type: "number", default: "50", description: "Max rows, HARD-CAPPED at 200 by the backend. Asking for more is not an error and not honoured — you get 200 rows and a stderr warning; `truncated: true` says the page was capped (fb#605). Page the rest with --offset." },
      { name: "offset", type: "number", default: "0", description: "Skip N rows — how you reach anything beyond the 200-row cap. `--limit 200`, then `--limit 200 --offset 200`, and so on." },
      { name: "full", type: "boolean", description: "Return untruncated description/resolution (default: each capped at 200 chars)" },
      { name: "unclaimed", type: "boolean", description: "Only items no agent currently holds — the set you should pick from. Includes rows whose claim EXPIRED (the 24h reclamation), not just never-claimed ones. Mutually exclusive with --mine/--claimed-by." },
      { name: "mine", type: "boolean", description: "Only items YOU currently hold (shorthand for --claimed-by <your resolved label>)" },
      { name: "claimed-by", type: "string", description: "Only items held by this label, and only while the claim is still LIVE" },
    ],
    outputShape:
      "{ items: FeedbackRow[] (description/resolution/errorText capped at 200 chars unless --full), nextCursor: null, count, truncated?, hint? }. Each row carries `changelogLinks: [{changelogId, role}]` — the same shape `get` returns — so a PARTLY-shipped row is visible before you claim it (fb#647).",
    // 18 columns is far past what a terminal table holds, and the triage-
    // relevant ones (scope/severity/complexity) sit at the END of the row, so
    // the automatic leftmost-fits fallback would hide exactly the wrong half.
    prettyColumns: ["feedbackId", "kind", "scope", "status", "severity", "complexity", "description"],
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "use only one of --all / --unresolved / --status; --status values must be open|reviewed|applied|dismissed; --kind must be improvement|bug|idea|legal and --scope one of cli|app|jerry|bsg2|workspace|security|ops|impeccable|other (both STRICT — they are server-side SQL filters, so an unknown value would return an empty list that reads as 'nothing filed')" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Default scope is the active bucket (open + reviewed). Pass --all to include closed (applied/dismissed) items, or --status applied to target them.",
      "--search is a server-side substring filter added in a later backend version; against an older backend it is silently ignored (the list returns unfiltered) — deploy-gated.",
      "--complexity / --max-complexity filter on the AI-triage complexity estimate (1-5). `--max-complexity 3 --unresolved` is the autonomously-workable backlog for a batch-fix agent; also deploy-gated (ignored by an older backend).",
      "--oldest sorts createdAt ASC so the automated triage loop drains the backlog oldest-first (FIFO) instead of favouring the newest reports it reads first; the human default stays newest-first. Layer it under a priority filter (e.g. `--kind bug --oldest`) to keep breakages ahead of age.",
      "Each row carries claimState (free|held|mine). An expired claim reads as `free` — the lease is evaluated against the clock, never a stored flag, so a lapsed 24h claim reappears here automatically.",
      "PARTLY-SHIPPED ROWS (fb#647): a row can carry `changelogLinks` and still be open — that is a fix recorded with `ib dev changelog add --feedback <id> --no-resolve`, which links the shipped half WITHOUT closing the row. Any linked row that is still OPEN or REVIEWED is also named in a one-line stderr note (a closed row always has a `resolves` link, so those are not worth saying). Read the entry (`ib dev changelog get <id>`) BEFORE claiming it, or you will re-investigate work that already shipped. Deploy-gated: an older backend sends no links and the note simply does not fire — its absence never means 'nothing shipped'.",
    ],
    examples: [
      "ib dev feedback list",
      "ib dev feedback list --all",
      "ib dev feedback list --status applied --scope cli",
      "ib dev feedback list --kind bug --limit 20",
      "ib dev feedback list --search IDOR",
      "ib dev feedback list --max-complexity 3 --unresolved",
      "ib dev feedback list --scope cli --oldest",
    ],
  },
  {
    command: "ib dev feedback get",
    aliases: ["ib dev feedback show"],
    description:
      "Fetch one feedback row by id (developer-only).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" }],
    flags: [
      {
        name: "full",
        type: "boolean",
        description:
          "Accepted for cross-command consistency; get always returns the full row (no-op).",
      },
    ],
    outputShape: "The full feedback row { feedbackId, kind, scope, status, description, command, errorText, cliVersion, context, resolution, createdAt, ... }",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — if the id exists in devChangelog the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "The id accepts an optional `fb#` type anchor (e.g. `fb#42`); a `cl#` id is rejected up front (exit 4, code WRONG_REF_TYPE) with the corresponding `ib dev changelog get` command in the hint — feedback #230. A bare id that is actually a changelog id 404s here and the error hint points at the changelog command.",
    ],
    seeAlso: ["ib dev feedback list", "ib dev changelog get"],
    examples: ["ib dev feedback get 42", "ib dev feedback get fb#42"],
  },
  {
    command: "ib dev feedback resolve",
    description:
      "Triage a feedback row: set its status and/or attach a resolution note (developer-only). This IS a real write — blocked under --read-only (exit 3). --dry-run previews the update body client-side without sending.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [
      { name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" },
      { name: "note", type: "string", required: false, description: "The resolution note, positionally — the same field as --note, so `resolve 42 --status applied -- \"…\"` works exactly like `--note \"…\"`. Mirrors its sibling `ib dev feedback create <description>`, which has always taken its prose positionally (fb#583). Giving both is fine: distinct values merge, identical ones store once." },
    ],
    flags: [
      { name: "status", type: "string", description: "open | reviewed | applied | dismissed", allowed: [...FEEDBACK_STATUSES] },
      { name: "note", type: "string", description: "Resolution note stored on the row (same field as the positional)" },
      { name: "reason", type: "string", description: "Alias for --note — here it IS the stored note, NOT the X-Action-Reason audit header" },
      { name: "resolution", type: "string", description: "Alias for --note (matches the output field name); distinct values across the three note flags are merged into one note" },
      { name: "from-json", type: "string", description: "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: status, note (or reason/resolution). An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the only way to pass a note containing quotes on Windows PowerShell." },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
      { name: "full", type: "boolean", description: "Return the full updated row instead of the compact ack" },
    ],
    outputShape:
      "A compact ack { feedbackId, status, updatedAt, resolution } (resolution capped at 200 chars; the full row with --full). A note-only call that leaves the row open/reviewed adds hint naming the closing statuses. With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      // Both client rows sit at exit 4, so EACH must carry `match` — an
      // unmatched row would win by exit alone and serve the wrong remedy
      // (the fb#305/#306 ambiguity).
      { origin: "client", exit: 4, match: ["provide --status", "--status must be one of"], meaning: "Validation", remedy: "provide --status and/or --note; status must be a known value" },
      // Since fb#583 ONE excess positional is the note, so reaching this row
      // takes TWO or more — which on Windows PowerShell means the shell split
      // the note rather than the caller passing two notes on purpose.
      { origin: "client", exit: 4, match: "too many arguments", meaning: "The shell split the note on its inner double-quotes (typical on Windows PowerShell) — a single positional note is accepted", remedy: "pass the note via --from-json <file|-> instead of argv" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — a bare id that is actually a changelog id 404s here and the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "The note can be POSITIONAL or a flag — `resolve 42 --status applied -- \"…\"` and `resolve 42 --status applied --note \"…\"` are the same call (fb#583). The positional matches `ib dev feedback create <description>`; the two sibling commands used to disagree about where prose goes, which is the whole reason this was worth changing.",
      "--note/--reason/--resolution and the positional write the SAME stored note. Passing several with different values merges them (joined in positional→note→resolution→reason order) instead of dropping any — so mixing up --reason with the audit header loses nothing, and repeating the same text stores it once.",
      "A note WITHOUT --status does NOT close the row — it stays open/reviewed and the ack carries a hint saying so; pass --status applied|dismissed to close (feedback #270).",
      "The two ways to close a row have OPPOSITE defaults, so don't assume this one closes: `ib dev changelog add --feedback <id>` closes it for you (status=applied plus a `Shipped: changelog #N` resolution), while this command leaves the status alone unless you pass --status. Recording the fix in the changelog is the one-call path (feedback #293). Note the one-call path only advances a row from `open` — if you set this row to `reviewed` first, a later `changelog add --feedback` will preserve that and tell you so, rather than claiming shipped work that is only staged (fb#517).",
      "SHELL QUOTING (fb#327): a resolution note quotes commands and errors, and a quote-split can even store the note TRUNCATED at the first quote — use --from-json <file|-> for any quote-bearing note; see `ib help shell-quoting`.",
      "FIXED ONLY PART OF IT? Do not choose between closing the row and recording nothing — there is a third path (fb#647). `ib dev changelog add --feedback <id> --no-resolve` links the entry with role `references`, recording the shipped half WITHOUT touching the status; then `ib dev feedback update <id> --append-description \"shipped: X; remaining: Y\"` (and `--scope` if the residue belongs to another repo) narrows the row to what is left. The link is what makes it legible: `feedback list` and `claim` both name a linked row, so the next agent reads your entry instead of rediscovering it. Leaving a partial fix unrecorded is the failure this exists to prevent — it costs every later agent the same investigation.",
    ],
    seeAlso: ["ib dev changelog add", "ib dev feedback list", "ib dev feedback update"],
    examples: [
      'ib dev feedback resolve 42 --status applied --note "added row counts in CLI v1.3"',
      'ib dev feedback resolve 42 --status applied -- "the note works positionally too"',
      'ib dev feedback resolve 42 --status dismissed --note "by design"',
      "ib dev feedback resolve 42 --from-json ./resolution.json",
      "ib dev feedback resolve 42 --from-json ./resolution.json --status dismissed",
    ],
  },
  {
    command: "ib dev feedback update",
    description:
      "Edit a filed row's classification (--scope/--kind/--severity/--complexity) or its --description (developer-only). The correction twin of `resolve` (which sets status/note) — same PUT /api/feedback/:id endpoint. A real write, blocked under --read-only (exit 3). --dry-run previews the body client-side. Deploy-gated: an older backend ignores these fields and 400s on a status-less body.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" }],
    flags: [
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other", allowed: [...FEEDBACK_SCOPES] },
      { name: "kind", type: "string", description: "improvement | bug | idea | legal", allowed: [...FEEDBACK_KINDS] },
      { name: "severity", type: "string", description: "critical | major | minor | cosmetic", allowed: [...FEEDBACK_SEVERITIES] },
      { name: "complexity", type: "number", description: "1-5 agent-triage estimate — promote/downgrade after investigation (see `ib help complexity`)" },
      { name: "description", type: "string", description: "REPLACE the freetext description (destructive — the filed report is overwritten; use --append-description to add to it)" },
      { name: "body", type: "string", description: "Alias for --description (free text, not JSON); if both are passed, they must match" },
      { name: "append-description", type: "string", description: "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the original report intact" },
      { name: "from-json", type: "string", description: "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: scope, kind, severity, complexity, description (or body), appendDescription. An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the only way to pass prose containing quotes on Windows PowerShell." },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
      { name: "full", type: "boolean", description: "Return the full updated row instead of the compact ack" },
    ],
    outputShape:
      "A compact ack { feedbackId, scope, kind, severity, complexity, updatedAt, description? } (description capped at 200 chars; the full row with --full). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      // Three client rows share exit 4, so EACH needs `match` — an unmatched row
      // wins by exit alone and serves the wrong remedy (the fb#305/#306 ambiguity
      // that error-origins.test.ts enforces).
      { origin: "client", exit: 4, match: ["provide at least one of", "must be one of", "must be an integer", "must be non-empty", "mutually exclusive", "not both with different values"], meaning: "Validation", remedy: "provide at least one of --scope/--kind/--severity/--complexity/--description/--append-description; enum values must be valid; --complexity must be an integer 1-5; --description and --append-description are mutually exclusive" },
      { origin: "client", exit: 4, match: "too many arguments", meaning: "The shell split the description on its inner double-quotes (typical on Windows PowerShell)", remedy: "pass the text via --from-json <file|-> instead of argv" },
      { origin: "client", exit: 4, match: "--from-json", meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key", remedy: "check the path; the root must be an object and every key an accepted field name (the error lists them)" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — a bare id that is actually a changelog id 404s here and the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "--description REPLACES the stored report; --append-description ADDS to it (read-merge-write, blank-line separated). Prefer append for later commentary — a replace that goes wrong destroys the original evidence, and feedback rows have no version history to recover it from. The two are mutually exclusive (exit 4).",
      "SHELL QUOTING (fb#332): --description OVERWRITES the filed report, so a quote-split truncation is destructive — use --from-json <file|-> for long or quote-bearing text; see `ib help shell-quoting`.",
    ],
    seeAlso: ["ib dev feedback resolve"],
    examples: [
      "ib dev feedback update 42 --scope security",
      "ib dev feedback update 42 --kind bug --severity major",
      "ib dev feedback update 42 --complexity 4",
      "ib dev feedback update 42 --from-json ./correction.json",
      'ib dev feedback update 42 --append-description "Confirmed on prod 2026-08-06; root cause is the cache key."',
    ],
  },
  {
    command: "ib dev feedback claim",
    description:
      "Take (or renew) the work claim on a feedback row so no other agent starts the same item (developer-only). Mutual exclusion is REAL: the backend acquires via one atomic UPDATE, so exactly one of two racing agents wins and the other gets 409. A REAL write — blocked under --read-only.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor" }],
    flags: [
      { name: "by", type: "string", description: "The claiming agent/session label. Defaults to the hosted bridge's per-caller identity, then $IB_CLAIM_ID, then user@host. Every agent authenticates as the same person, so this label is the ONLY thing that distinguishes sessions — pass your session short id. Over MCP ib_exec this is now an OVERRIDE rather than a requirement: the bridge supplies the MCP session id as `mcp:<uuid>` (fb#616). Over POST /api/cli/exec, pass `claimId` in the request body or --by here — that path is stateless and has no identity to derive. If the backend can supply neither, `claim` REFUSES rather than issuing a lease keyed on a label every hosted caller shares." },
      { name: "ttl-hours", type: "number", description: "Lease length in hours, 1-24 (default 24). The 24h ceiling is ABSOLUTE: it is measured from your FIRST acquire, so renewing cannot extend past it." },
      { name: "steal", type: "boolean", description: "Take a row that is under another agent's LIVE claim. For human recovery; normal contention should pick a different item instead." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ],
    outputShape:
      "The claimed feedback row, including claimedBy, claimedAt, claimExpiresAt and `changelogLinks: [{changelogId, role}]`.",
    errors: [
      // The 1-24 range check is SERVER-side (feedback.js claim(): sendValidationError
      // -> HTTP 400), not client-side — runFeedbackClaim forwards ttlHours unchecked.
      // An `origin:"client"` row here is unreachable (matchClientRow only runs when
      // statusCode===0; a real 400 never hits it), which silently drops the remedy
      // for the most likely misuse. Must key on `http:400` so matchHttpRow finds it.
      apiErr(400, "Validation", "--ttl-hours must be 1-24", "ttlhours"),
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list`"),
      apiErr(409, "Already claimed, or already closed", "the message names the holder and expiry — pick another item with `ib dev feedback list --unclaimed`, or pass --steal to take it anyway"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Claiming is how concurrent AI agents avoid duplicating work. Browse with `ib dev feedback list --unclaimed`, choose an item yourself, then claim it. On a 409, pick a different item — do not wait.",
      "Re-claiming an item you already hold is idempotent and doubles as the RENEWAL path; there is no separate renew command. It cannot extend the lease past 24h from your first acquire.",
      "An abandoned claim frees itself: expiry is evaluated at read time, so after 24h the row is claimable again with no sweeper and no manual cleanup.",
      "Closing a row (`resolve --status applied|dismissed`) releases the claim automatically.",
      "If the row already carries changelog links, claiming it prints a one-line stderr note naming them (fb#647). An open row CAN have links: `ib dev changelog add --feedback <id> --no-resolve` records a partial fix without closing the row, so part of the item may already have shipped. Read the named entry (`ib dev changelog get <id>`) before starting — that note exists because an agent once spent a whole investigation cycle rediscovering a half that had already shipped.",
    ],
    seeAlso: ["ib dev feedback release", "ib dev feedback list", "ib dev feedback resolve"],
    examples: [
      "ib dev feedback claim 42 --by c6b96c",
      "ib dev feedback claim 42 --by c6b96c --ttl-hours 4",
      "ib dev feedback claim 42 --by c6b96c --steal",
    ],
  },
  {
    command: "ib dev feedback release",
    description:
      "Release a work claim you hold, so another agent can pick the item up (developer-only). --all releases every claim held by your label — what a session should do on exit. A REAL write — blocked under --read-only.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    args: [{ name: "id", type: "number", required: false, description: "feedbackId — omit when using --all" }],
    flags: [
      { name: "by", type: "string", description: "The holder label. Defaults to the hosted bridge's per-caller identity, then $IB_CLAIM_ID, then user@host — must match the label used to claim. Over MCP ib_exec the bridge supplies `mcp:<session-uuid>` automatically (fb#616), so this is an override; over POST /api/cli/exec supply `claimId` in the body or --by here. Without any identity, `--all` REFUSES (it would release every hosted caller's claims, not just yours); releasing a single named id is still allowed." },
      { name: "all", type: "boolean", description: "Release EVERY claim held by this label instead of one row" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ],
    outputShape: "{ feedbackId, released:true } for one row; { by, released:<count> } with --all.",
    errors: [
      { origin: "client", exit: 4, match: "provide a feedbackid", meaning: "Validation", remedy: "pass a feedbackId, or --all to release every claim" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list`"),
      apiErr(409, "You do not hold that claim", "check the holder with `ib dev feedback get <id>`; --by must match the label used to claim"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Releasing is an optimisation, not the correctness mechanism — an abandoned claim expires on its own after 24h. Release so the item frees in seconds instead.",
    ],
    seeAlso: ["ib dev feedback claim", "ib dev feedback list"],
    examples: [
      "ib dev feedback release 42 --by c6b96c",
      "ib dev feedback release --all --by c6b96c",
    ],
  },
  {
    command: "ib dev feedback count",
    description:
      "Aggregate counts of filed feedback by status, kind, and scope, plus how many rows still have NO complexity estimate (developer-only). The cheapest way to answer \"is there any open feedback?\" — a tiny fixed-size response instead of a row dump. Aggregated server-side over the WHOLE table, so the totals stay correct at any volume.",
    // `stats` mirrors the backend route this wraps (GET /api/feedback/stats), so
    // a caller who read the route table or the module reaches for that spelling
    // (fb#611). It previously dead-ended on exit 4 and — worse — pointed at
    // `ib stats`, an unrelated delivery-statistics domain.
    aliases: ["ib dev feedback stats"],
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "kind", type: "string", description: "improvement | bug | idea | legal — count only this kind", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — count only this scope", allowed: [...FEEDBACK_SCOPES] },
    ],
    outputShape:
      "{ total, byStatus: { open, reviewed, applied, dismissed }, byKind, byScope, unestimated, truncated?, hint? }. `unestimated` = rows with complexity IS NULL — pair it with `list --complexity none` to work through them.",
    notes: [
      "DEPLOY-GATED (fb#536): the server-side aggregate needs /api/feedback/stats. Against an older backend the command falls back to the previous client-side rollup over a 200-row page and sets `truncated: true` with a hint — those numbers are a LOWER BOUND, and because the page is newest-first the rows dropped are the OLDEST, so `open` is understated most. Cross-check a truncated result with `ib dev feedback list --status open --limit 200`.",
    ],
    errors: [
      { origin: "client", exit: 4, match: "must be one of", meaning: "Validation", remedy: "--kind must be improvement|bug|idea|legal and --scope one of cli|app|jerry|bsg2|workspace|security|ops|impeccable|other (both STRICT — they are server-side SQL filters, so an unknown value would report total:0 rather than an error)" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: ["ib dev feedback count", "ib dev feedback count --scope cli", "ib dev feedback count --kind legal"],
  },
  // ─── ai (2) — read AI assistant conversations ────────────────────────────
  {
    command: "ib dev ai conversations",
    description:
      "List recent /ai assistant conversations CROSS-TENANT for audit/browse (compact rows, newest-first, no message bodies). Developer/sysadmin tooling — the way to discover conversationIds to audit without an `ib feedback` row pointing at one. Drill into a transcript with `ib dev ai conversation <id>`.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "limit", type: "number", default: "20", description: "Max rows to return (1-100)" },
      { name: "person", type: "number", description: "Filter to one person's conversations (personId)" },
    ],
    outputShape:
      "ListEnvelope<{ conversationId, personId, ownerAsiakasId, entryTime, messageCount }> (truncated:true when the page hit --limit)",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--limit must be 1-100; --person must be a positive integer" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Cross-tenant by design: rows from EVERY tenant are returned and the active --company does NOT narrow them (each row carries its own ownerAsiakasId). Transcripts may contain PII — hence the developer gate.",
      "Excludes archived conversations (gptConversations.isArchived=1) and conversations with zero messages, so an id taken from a feedback row can legitimately be absent here while `ib dev ai conversation <id>` still returns it.",
      "No cursor: nextCursor is always null. truncated:true means the page filled --limit — raise --limit (max 100) rather than trying to page.",
    ],
    seeAlso: ["ib dev ai conversation", "ib dev feedback list"],
    examples: [
      "ib dev ai conversations",
      "ib dev ai conversations --limit 50",
      "ib dev ai conversations --person 6233",
    ],
  },
  {
    command: "ib dev ai conversation",
    description:
      "Fetch the full transcript of an /ai assistant conversation by id (gptConversations/gptMessages). Developer/sysadmin tooling. Get an id by browsing with `ib dev ai conversations`, or from an `ib feedback` row's context.conversationId — stamped automatically when the AI files feedback from the /ai page.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "conversationId", type: "number", description: "gptConversations id (from `ib dev ai conversations` or a feedback row's context.conversationId)" }],
    flags: [],
    outputShape:
      "{ conversationId, personId, ownerAsiakasId, messageCount, messages: [{ gptMessageId, keikkaId, role?, content?, raw?, ... }] }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "conversationId must be a positive integer" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(404, "Not found", "no conversation with that id"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Cross-tenant by design: the transcript is readable whatever the caller's active company, because the AI fixer triages `ib feedback` rows from any tenant. Transcripts may contain PII — hence the developer gate.",
      "Each message is { gptMessageId, keikkaId, ...JSON.parse(gptMessages.message) } — normally role/content, but a row whose stored message is NOT valid JSON falls back to { gptMessageId, keikkaId, raw }. Handle `raw` as well as `content`.",
    ],
    seeAlso: ["ib dev ai conversations", "ib dev feedback get", "ib dev feedback list"],
    examples: ["ib dev ai conversation 4321"],
  },
  // ─── cache (6) — Redis inspection and invalidation ───────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["isSystemAdmin or isDeveloper"];
    const ADMIN_PERMS = ["admin role (SystemAdmin, AsiakasAdmin, or LaskuAdmin) or developer"];
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "requires isSystemAdmin or isDeveloper"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const refusedRemote: CommandError = {
      origin: "client",
      exit: 3,
      match: "shared-cache",
      meaning: "Refused: deployed endpoint without --force-prod",
      remedy: "prod and staging share Redis DB 3; add --force-prod or use a local endpoint",
    };
    const readOnlyErr: CommandError = {
      origin: "client",
      exit: 3,
      match: "read-only mode is active",
      meaning: "Blocked by read-only mode",
      remedy: "executing a cache write needs --confirm and a session without --read-only/IB_READ_ONLY (previews still work)",
    };
    const writeFlags = [
      { name: "confirm", type: "boolean", description: "Execute the operation (default is dry-run preview)" },
      { name: "dry-run", type: "boolean", description: "Preview without deleting — the DEFAULT here, so this flag is an explicit no-op. Accepted because it is the CLI-wide preview spelling; this group inverts the usual idiom and previews unless --confirm. Passing it WITH --confirm exits 4 rather than picking a winner." },
      { name: "force-prod", type: "boolean", description: "Execute against a deployed (shared-cache) backend. Sent as X-Force-Prod: 1; a deployed backend refuses destructive cache ops without it (403) — including calls routed via /api/cli/exec and MCP ib_exec." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ];
    const contradictoryWriteFlags: CommandError = {
      origin: "client",
      exit: 4,
      match: "mutually exclusive",
      meaning: "--dry-run and --confirm passed together",
      remedy: "drop --dry-run to execute, or drop --confirm to preview (preview is the default)",
    };
    return [
      {
        command: "ib dev cache stats",
        description: "Redis connection status, total key count, and hit rate. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ connected, totalKeys, hitRate?, usedMemory? }",
        errors: devErrors,
        examples: ["ib dev cache stats"],
      },
      {
        command: "ib dev cache keys",
        description: "Key counts grouped by prefix pattern (SCAN). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "pattern", type: "string", default: "*", description: "SCAN match glob (default: *)" }],
        outputShape: "{ totalKeys, groups: [{ prefix, count }] }",
        errors: devErrors,
        examples: ["ib dev cache keys", "ib dev cache keys --pattern 'keikka:*'"],
      },
      {
        command: "ib dev cache invalidate",
        description: "Invalidate cache for one entity family by domain identifier (no Redis key knowledge needed). Previews (X-Dry-Run) unless --confirm. --cascade fans out to related families (keikka only). Any admin; non-developers are scoped to their own company. Guard: refuses deployed endpoints unless --force-prod (all slots share Redis DB 3).",
        permissions: ADMIN_PERMS,
        mutates: true,
        args: [{ name: "entityType", type: "string", description: "Entity family, e.g. keikka/asiakas/vehicle (see `ib dev cache entities`)" }],
        flags: [
          { name: "id", type: "number", description: "Entity id (e.g. keikkaId)" },
          { name: "asiakas", type: "number", description: "Tenant scope (developers may target others; non-devs use their own)" },
          { name: "cascade", type: "boolean", description: "Also invalidate related families (keikka only)" },
          ...writeFlags,
        ],
        outputShape: "preview: { dryRun:true, wouldDelete, patterns[] } | execute: { dryRun:false, deleted }",
        errors: [
          apiErr(400, "Unknown entityType or cascade unsupported", "run `ib dev cache entities` to list valid types"),
          apiErr(403, "Not an admin, or cross-tenant entity needs developer", "cross-tenant entities (keikka, grid, stat, attachment) require isSystemAdmin/isDeveloper; others need an admin role"),
          refusedRemote,
          readOnlyErr,
          contradictoryWriteFlags,
          ...COMMON_AUTH_ERRORS,
        ],
        notes: [
          "Without --confirm the command only PREVIEWS (counts keys) and never deletes.",
          "This group INVERTS the CLI-wide write-safety idiom: elsewhere a write performs by default and --dry-run previews; here it previews by default and --confirm performs. --dry-run is accepted as an explicit spelling of that default so the two idioms compose.",
          "Single-entity invalidate may leave related caches (grid/stepLog/attachments) stale — use --cascade (keikka) or invalidate each family.",
        ],
        seeAlso: ["ib dev cache entities", "ib dev cache keys"],
        examples: [
          "ib dev cache invalidate keikka --id 123",
          "ib dev cache invalidate keikka --id 123 --cascade --confirm",
          "ib dev cache invalidate asiakas --asiakas 8 --confirm",
        ],
      },
      {
        command: "ib dev cache clear",
        description: "Flush the entire Redis cache (curated sweep; preserves sessions/locks/metrics). Previews (X-Dry-Run) unless --confirm. Cross-tenant: clears every company's cached data. Guard: refuses deployed endpoints unless --force-prod. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        mutates: true,
        flags: writeFlags,
        outputShape: "preview: { dryRun:true, wouldDelete } | execute: { deleted }",
        errors: [...devErrors, refusedRemote, readOnlyErr, contradictoryWriteFlags],
        examples: ["ib dev cache clear", "ib dev cache clear --confirm --force-prod"],
      },
      {
        command: "ib dev cache pattern",
        description: "Invalidate keys matching a raw Redis glob. Previews unless --confirm. Guard: refuses deployed endpoints unless --force-prod. Developer-only. Prefer `ib dev cache invalidate` (domain entity); use `ib dev cache keys` to find the right glob.",
        permissions: DEV_PERMS,
        tier: "developer",
        mutates: true,
        args: [{ name: "glob", type: "string", required: false, description: "Raw Redis key glob (e.g. 'keikka:*'). Alias: --pattern <glob>, matching the spelling the sibling `ib dev cache keys` uses for the same concept — exactly one is required, both only if they agree." }],
        flags: [
          { name: "pattern", type: "string", description: "Raw Redis key glob (alias for the positional)" },
          ...writeFlags,
        ],
        outputShape:
          "preview: { dryRun:true, wouldDelete, pattern, sampleKeys } | execute: { deleted, pattern }. When wouldDelete is 0 the preview ALSO carries { totalKeys, existingPrefixes[], hint } — a zero alone cannot tell 'cache is clean' from 'your glob is wrong', so those fields settle it without a second command (feedback #431).",
        errors: [
          ...devErrors,
          refusedRemote,
          readOnlyErr,
          contradictoryWriteFlags,
          {
            origin: "client",
            exit: 4,
            // Matches the shared resolveDualString message ("missing glob: …").
            // matchClientRow keys on the message TEXT, and this command now has
            // two client rows at exit 4, so the single-row fallback cannot
            // rescue a stale string — it would silently serve no remedy at all
            // (the dead-row class of feedback #280/#289).
            match: "missing glob",
            meaning: "No glob given, positionally or via --pattern",
            remedy: "pass the glob positionally (`ib dev cache pattern 'keikka:*'`) or as --pattern 'keikka:*'",
          },
          {
            origin: "client",
            exit: 4,
            match: "differ",
            meaning: "The positional glob and --pattern were both given and disagree",
            remedy: "pass the glob ONCE — only one of the two could be honoured, so the CLI refuses rather than silently picking",
          },
        ],
        examples: [
          "ib dev cache pattern 'keikka:*'",
          "ib dev cache pattern --pattern 'keikka:*'",
          "ib dev cache pattern 'person:*' --confirm --force-prod",
        ],
      },
      {
        command: "ib dev cache entities",
        description: "List the valid cache entity types, their scope params (id/asiakasId), cascade support, and example invalidation commands. Offline — no auth required.",
        auth: "none",
        flags: [],
        outputShape: "{ items: [{ entityType, params[], cascade?, developerOnly?, example }], count }",
        errors: [{ origin: "client", exit: 0, meaning: "Always succeeds (offline static list)", remedy: "n/a" }],
        examples: ["ib dev cache entities"],
      },
    ];
  })(),

  // ─── perf (4) — SQL slow-query monitoring ────────────────────────────────
  ...((): CommandSpec[] => {
    const DEV_PERMS = ["isSystemAdmin or isDeveloper"];
    const devErrors: CommandError[] = [
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a developer", "requires isSystemAdmin or isDeveloper"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ];
    const COVERAGE_NOTE =
      "SQL durations cover the executeQuery (cache-runner) path only — raw getConnection() queries are not timed.";
    return [
      {
        command: "ib dev perf slow",
        description: "Recent slow queries from the collector's Redis ring buffer (procedure, durationMs, entity, params, timestamp). Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [
          { name: "limit", type: "number", default: "50", description: "Max rows" },
          { name: "env", type: "string", description: "Environment buffer to read (default: backend's current env; discover via `ib dev perf config`)" },
        ],
        outputShape: "ListEnvelope<{ procedure, durationMs, entity, params, timestamp }> & { totalCount?, environment? } (+truncated:true when the page filled the limit)",
        errors: devErrors,
        notes: [COVERAGE_NOTE, "Threshold to be 'slow' is the collector's SLOW_QUERY_THRESHOLD_MS (default 1000ms) — see `ib dev perf config`."],
        seeAlso: ["ib dev perf stats", "ib dev perf config"],
        examples: ["ib dev perf slow", "ib dev perf slow --limit 20 --env production"],
      },
      {
        command: "ib dev perf stats",
        description: "Aggregate slow-query stats: top procedures (count/avgMs), avg/max/min duration, by-entity breakdown, lifetime totalCount. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [{ name: "env", type: "string", description: "Environment buffer to read (default: backend's current env)" }],
        outputShape: "{ totalSlowQueries, bufferedQueries, avgDuration, maxDuration, minDuration, topProcedures:[{ name, count, avgMs }], byEntity, since, threshold, sentryThreshold, environment }",
        errors: devErrors,
        notes: [COVERAGE_NOTE],
        seeAlso: ["ib dev perf slow", "ib dev perf config"],
        examples: ["ib dev perf stats", "ib dev perf stats --env staging"],
      },
      {
        command: "ib dev perf config",
        description: "Slow-query collector configuration (enabled, threshold, sentryThreshold, maxEntries, current environment) plus availableEnvironments that have data. Developer-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        flags: [],
        outputShape: "{ enabled, threshold, sentryThreshold, maxEntries, environment, availableEnvironments:[string] }",
        errors: devErrors,
        seeAlso: ["ib dev perf slow", "ib dev perf stats"],
        examples: ["ib dev perf config"],
      },
      {
        command: "ib dev perf clear",
        description: "Clear the slow-query buffer for one environment. Previews with --dry-run (client-side); --reason recommended for the audit log. Developer-only; refused under --read-only.",
        permissions: DEV_PERMS,
        tier: "developer",
        mutates: true,
        writeFlags: true,
        dryRunKind: "client",
        flags: [{ name: "env", type: "string", description: "Environment buffer to clear (default: backend's current env)" }],
        outputShape: "execute: { cleared:true, environment, message } | --dry-run: { dryRun:true, wouldClear:{ method, path } }",
        errors: [
          ...devErrors,
          { origin: "client", exit: 3, meaning: "Blocked by read-only mode", remedy: "clearing needs a session without --read-only/IB_READ_ONLY" },
        ],
        seeAlso: ["ib dev perf stats"],
        examples: ['ib dev perf clear --env staging --reason "reset after load test"', "ib dev perf clear --dry-run"],
      },
    ];
  })(),

  // ─── log (6) ─────────────────────────────────────────────────────────────
  {
    command: "ib log entity",
    description:
      "Change-tracker audit trail for ONE entity of any type — who changed which field, when, old→new, and the --reason recorded by writes. GET /api/changes/:entityType/:entityId/:ownerAsiakasId; owner defaults to the active company. entityType is validated client-side against the offline catalog (`ib log types`); 'keikka' folds in the keikka's keikkaBetoni rows; deprecated 'kuski' is accepted with a stderr note. --field filters client-side AFTER the server's --limit page — on a capped page an empty result means 'not in the newest --limit changes', NOT 'this field never changed' (the envelope then carries a hint; raise --limit or use `ib log by-entity-date`).",
    auth: "any",
    args: [
      { name: "entityType", type: "string", description: "One of `ib log types` (e.g. keikka, vehicle, pumppuRequest)" },
      { name: "entityId", type: "number", description: "The entity's id (see entityIdMeaning in `ib log types`)" },
    ],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (capped at 500)" },
      { name: "field", type: "string", description: "Filter by changeTracker fieldName (client-side)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName, keikkaTilaContext, deviceType }>" +
      LOG_CAPPED_NOTE +
      LOG_FIELD_HINT_NOTE,
    errors: authErrors(
      apiErr(403, "Not a member of that company — or entityType personAvailability without an admin role", "ib company switch to that owner, or use an admin token"),
      { origin: "client", exit: 4, meaning: "Unknown entityType (client-side validation)", remedy: "ib log types" }
    ),
    notes: [
      "personAvailability is admin-gated server-side; every other type needs company membership only.",
      "Shortcuts: ib keikka|vehicle|worksite log (same row shape) and ib person|customer log (slimmer rows without entityType/entityId).",
    ],
    seeAlso: ["ib log types", "ib keikka log", "ib log latest"],
    examples: [
      "ib log entity keikka 12345 --field kuskit",
      "ib log entity vehicle 53 --field vehicleRegNo",
      "ib log entity pumppuRequest 17",
    ],
  },
  {
    command: "ib log latest",
    description:
      "Newest changes across the whole active company, optionally one entityType — admin view for 'what just happened'. GET /api/changes/latest/:ownerAsiakasId. NOTE: reason/impersonator columns appear only after the 2026-06 aggregate-procs backend deploy; until then they are null.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "entity-type", type: "string", description: "Filter to one entityType" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (server cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName, keikkaTilaContext, deviceType }>" +
      LOG_CAPPED_NOTE,
    errors: authErrors(
      apiErr(403, "Not an admin in the owner company", "use an admin token, or per-entity `ib log entity`")
    ),
    seeAlso: ["ib log range", "ib log by-entity-date"],
    examples: ["ib log latest", "ib log latest --entity-type keikka --limit 50"],
  },
  {
    command: "ib log range",
    description:
      "All changes MADE within a time window (by change timestamp), optional entityType/person filters — admin forensic view. GET /api/changes/range/:ownerAsiakasId. The backend has no row cap; --limit slices client-side (truncated:true when cut). NOTE: reason/impersonatedByPersonName are null until the 2026-06 aggregate-procs backend deploy.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "from", type: "date", description: "Window start, YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "Window end, YYYY-MM-DD or ISO datetime (or today/yesterday/tomorrow)", required: true },
      { name: "entity-type", type: "string", description: "Filter to one entityType" },
      { name: "person", type: "number", description: "Filter to one actor personId (a non-integer value exits 4 client-side)" },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "200", description: "Max rows kept client-side (cap 2000)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personId, personName, at, description, reason, impersonatedByPersonName }> (+truncated when --limit cut rows)",
    errors: authErrors(
      apiErr(403, "Not an admin in the owner company", "use an admin token"),
      // `match` scopes the row to the date guard: it is the command's only
      // client/exit-4 row, so without it the exit-only fallback served "use
      // YYYY-MM-DD" for a non-integer --person too (fb#385).
      { origin: "client", exit: 4, match: "must be YYYY-MM-DD", meaning: "Invalid --from/--to (client-side)", remedy: "use YYYY-MM-DD or ISO datetime; today/yesterday/tomorrow are also accepted" },
      apiErr(400, "Backend rejected the dates", "use ISO date strings")
    ),
    seeAlso: ["ib log by-entity-date"],
    examples: [
      "ib log range --from 2026-06-01 --to 2026-06-10",
      "ib log range --from yesterday --to today --entity-type keikka --person 63",
    ],
  },
  {
    command: "ib log by-entity-date",
    description:
      "Changes affecting deliveries DATED in the window — filters by the entity's own date (keikka.pumppuAika / grid_palkit.starttime), NOT the change timestamp. This is what the grid Muutoshistoria drawer shows: 'everything that touched that day's deliveries, whenever the change was made'. GET /api/changes/by-entity-date/:ownerAsiakasId. Admin only. NOTE: reason/impersonatedByPersonName are null until the 2026-06 aggregate-procs backend deploy.",
    permissions: ["isAnyAdmin (asiakasAdmin/laskuAdmin/system admin)"],
    flags: [
      { name: "entity-type", type: "string", description: "keikka or palkki", required: true },
      { name: "from", type: "date", description: "Entity-date window start (or today/yesterday/tomorrow)", required: true },
      { name: "to", type: "date", description: "Entity-date window end (or today/yesterday/tomorrow)", required: true },
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "200", description: "Max rows kept client-side (cap 2000)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, personName, at, description, keikkaTilaContext, deviceType, palkkiText, palkkiVehicleRegNo, reason, impersonatedByPersonName }> (+truncated when --limit cut rows)",
    errors: authErrors(
      apiErr(403, "Not an admin in the owner company", "use an admin token"),
      { origin: "client", exit: 4, meaning: "entityType not keikka|palkki, or bad dates (client-side)", remedy: "use --entity-type keikka|palkki and ISO dates or today/yesterday/tomorrow" }
    ),
    seeAlso: ["ib log range"],
    examples: ["ib log by-entity-date --entity-type keikka --from today --to today"],
  },
  {
    command: "ib log user",
    description:
      "Changes MADE BY a person. Without personId: your own recent changes (GET /api/changes/user/recent/:owner — any member). With personId: that person's changes (GET /api/changes/user/:personId/:owner — self or admin). Rows carry entityDisplayName (e.g. '12345 - Tilaus') instead of personName (the actor IS the queried person).",
    auth: "any",
    args: [
      { name: "personId", type: "number", required: false, description: "Whose changes (omit = yourself; others need admin)" },
    ],
    flags: [
      { name: "owner", type: "number", description: "ownerAsiakasId (default: active company; a non-integer value exits 4 client-side)" },
      { name: "limit", type: "number", default: "100", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{ changeId, entityType, entityId, field, oldValue, newValue, changeType, at, description, deviceType, entityDisplayName, reason, impersonatedByPersonName }>" +
      LOG_CAPPED_NOTE,
    errors: authErrors(
      apiErr(403, "Another person's history without an admin role", "omit personId, or use an admin token")
    ),
    examples: ["ib log user", "ib log user 63 --limit 50"],
  },
  {
    command: "ib log types",
    description:
      "Offline catalog of changeTracker entityTypes: what each entityId means, the server-side read gate, and notes (deprecated kuski, keikka⊃keikkaBetoni fold-in, pumppuRequest two-party rows). No network, no auth.",
    auth: "none",
    flags: [],
    outputShape: "ListEnvelope<{ entityType, entityIdMeaning, gate: 'member'|'admin', notes, deprecated? }>",
    errors: [{ origin: "client", exit: 0, meaning: "Always succeeds (offline static list)", remedy: "n/a" }],
    examples: ["ib log types"],
  },

  // ─── help (1) ────────────────────────────────────────────────────────────
  {
    command: "ib help",
    description: "Concept guides for AI users. No arg lists topic ids; `ib help <topic>` prints one guide. Unknown topics fall back to `ib glossary lookup` (DB-backed).",
    auth: "none",
    args: [{ name: "topic", type: "string", required: false, description: "topic id (roles, jerry-lifecycle, write-safety, exit-codes, multi-tenancy, log, attachments) or a vocabulary term resolved via the DB glossary" }],
    flags: [],
    outputShape: "no arg: { items:[{id,title}], nextCursor:null, count } | with topic: { id, title, body }",
    errors: [{ origin: "client", exit: 5, meaning: "Unknown topic", remedy: "run `ib help` to list valid topic ids; or `ib glossary lookup <term>` for vocabulary" }],
    examples: ["ib help", "ib help write-safety", "ib help tila"],
  },

  // ─── search (1) ──────────────────────────────────────────────────────────
  {
    command: "ib search",
    description:
      "Cross-entity unified search: customers, worksites, persons, vehicles, keikkas and sijainnit in ONE flat ranked list. Client-side parallel fan-out over the per-entity searches — use this to resolve \"who/what is X\" without guessing the entity type.",
    auth: "any",
    args: [{ name: "query", type: "string", required: false, description: "Search string (or pass --search)" }],
    flags: [
      { name: "search", type: "string", description: "Search query (alias for the <query> positional)" },
      { name: "in", type: "string", description: "Comma-separated subset of: customer,worksite,person,vehicle,keikka,sijainti" },
      { name: "limit", type: "number", default: "5", description: "Max hits per entity" },
      { name: "my-companies", type: "boolean", description: "Search across every company you belong to (customer/worksite/person)" },
    ],
    outputShape:
      "{ items: [{ entity, id, label, detail, <nativeIdField> }], nextCursor: null, count, errors: [{ entity, message }] }",
    errors: COMMON_AUTH_ERRORS,
    notes: [
      "A failing/denied entity degrades gracefully into errors[] — exit 0 if at least one entity succeeded; if ALL fail, exits with the first failure's mapped code.",
      "Ordering: prefix label matches first, then entity order customer→worksite→person→vehicle→keikka→sijainti.",
      "Each hit carries its native id field (asiakasId/tyomaaId/personId/vehicleId/keikkaId/sijaintiId) for a follow-up `ib <entity> get <id>`.",
      "Sijainti is matched by name/address/typeName substring (type names like \"jäteasema\" match too) over scope=all — INCLUDING other companies' rows (supplier betoniasemat referenced by GPS visits/timeline). Newer backends pre-filter server-side; older ones return the own+shared 500-row scan and the filter runs client-side.",
      "--my-companies covers customer/worksite/person only; vehicle and keikka stay scoped to the active company (sijainti is already scope=all).",
    ],
    examples: [
      "ib search kamppi",
      "ib search 0401234567 --in person,keikka",
      "ib search \"Rudus\" --in customer --limit 10",
      "ib search jäteasema --in sijainti",
    ],
  },
  // ─── message chat (9) ────────────────────────────────────────────────────
  {
    command: "ib message chat threads",
    description:
      "List your conversational message threads (inbox), newest first, with unread counts and a last-message preview. Projects GET /api/messages/threads/mine into the list envelope; --unread / --tarjous filter client-side.",
    auth: "any",
    flags: [
      { name: "unread", type: "boolean", description: "Only threads with unreadCount > 0" },
      { name: "tarjous", type: "number", description: "Only threads for this pumppuRequestId" },
    ],
    outputShape:
      "ListEnvelope<{ threadId, contextType, contextId, ownerAsiakasId, createdAt, lastMessageAt, lastReadAt, unreadCount, lastMessageBody }>",
    errors: [...COMMON_AUTH_ERRORS],
    notes: [
      "Only threads you participate in are returned (server-scoped by your personId).",
      "A keikka thread (contextType 'keikka') appears here automatically once keikka messaging ships — no CLI change needed.",
    ],
    seeAlso: ["ib message chat list", "ib message chat thread"],
    examples: [
      "ib message chat threads",
      "ib message chat threads --unread",
      "ib message chat threads --tarjous 23",
    ],
  },
  {
    command: "ib message chat thread",
    description:
      "Get one thread's metadata + participants (display names, roles, asiakas). Target by threadId positional or resolve from --tarjous.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
    ],
    outputShape:
      "{ thread: { threadId, contextType, contextId, ownerAsiakasId, createdAt, lastMessageAt, archivedAt }, participants: [{ participantId, personId, asiakasId, role, joinedAt, lastReadAt, leftAt, personFirstName, personLastName, asiakasNimi }] }",
    errors: [
      apiErr(403, "Not a participant of this thread", "you can only read threads you are part of"),
      apiErr(404, "Thread not found", "verify the threadId / --tarjous"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--tarjous resolves client-side over /threads/mine; if it matches multiple threads (one per competing provider) you get exit 4 listing the threadIds — pass one explicitly.",
    ],
    seeAlso: ["ib message chat threads", "ib message chat list"],
    examples: ["ib message chat thread 42", "ib message chat thread --tarjous 23"],
  },
  {
    command: "ib message chat list",
    description:
      "List messages in a thread, oldest first. Does NOT mark the thread read (use `ib message chat mark-read`). Target by threadId or --tarjous; --since backfills, --limit caps.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "since", type: "string", description: "Only messages created after this ISO timestamp" },
      { name: "limit", type: "number", default: "100", description: "Max messages (server max 500)" },
      { name: "deleted", type: "boolean", description: "Include soft-deleted messages (your own; all for developers)" },
    ],
    outputShape:
      "ListEnvelope<{ messageId, threadId, senderPersonId, senderAsiakasId, kind, body, source, sourceNote, createdAt, editedAt, isDeleted, personFirstName, personLastName, senderAsiakasNimi }>",
    errors: [
      apiErr(403, "Not a participant of this thread", "you can only read threads you are part of"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Reading does NOT stamp lastReadAt — safe for an AI to browse without clearing your unread badge.",
      "source/sourceNote are null until the provenance backend change is deployed.",
      "--deleted sets ?includeDeleted=1: you see your own deleted rows, developers see all; rows carry isDeleted.",
    ],
    seeAlso: ["ib message chat send", "ib message chat mark-read"],
    examples: [
      "ib message chat list 42",
      "ib message chat list --tarjous 23 --limit 20",
      "ib message chat list 42 --since 2026-06-14T10:00:00Z",
    ],
  },
  {
    command: "ib message chat send",
    description:
      "Send a message to a thread (POST /api/messages/threads/:id/messages). Outward-facing: the recipient sees it and gets a push. --dry-run previews the body + recipients CLIENT-SIDE without sending. --reason is stored as the message's sourceNote (optional).",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "body", type: "string", required: true, description: "Message text (max 4000 chars)" },
      { name: "source", type: "string", description: "Provenance: web|cli|ai (default: IB_SOURCE env or cli)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, senderPersonId, senderAsiakasId, kind, body, source, sourceNote, createdAt } · { dryRun:true, threadId, wouldSend:{ body, source, sourceNote, recipients:[{ personId, name, role }] } } on --dry-run",
    errors: [
      apiErr(400, "Empty / too-long body", "body is required, max 4000 chars"),
      apiErr(403, "Not a participant of this thread", "you can only post to threads you are part of"),
      apiErr(409, "Thread archived", "archived threads are read-only"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "--dry-run only issues a GET (thread participants) — it works under --read-only and never persists.",
      "--reason → sourceNote (optional; chat is conversational). source/sourceNote are persisted only after the provenance backend change deploys; until then the API silently ignores them.",
      "An AI-driven send sets source=ai automatically via the IB_SOURCE env var.",
    ],
    seeAlso: ["ib message chat list", "ib message chat thread"],
    examples: [
      'ib message chat send 42 --body "Onko tyomaalle ajoyhteys raskaalle kalustolle?"',
      'ib message chat send --tarjous 23 --body "Kiitos tarjouksesta" --dry-run',
      'ib message chat send 42 --body "Vahvistettu" --reason "confirmed by phone"',
    ],
  },
  {
    command: "ib message chat mark-read",
    description:
      "Mark a thread read — stamp your lastReadAt to now (POST /api/messages/threads/:id/read), clearing the unread badge. A write, so blocked under --read-only.",
    auth: "any",
    args: [
      { name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" },
    ],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
    ],
    mutates: true,
    outputShape: "{ lastReadAt }",
    errors: [
      apiErr(403, "Not a participant of this thread", "you can only mark threads you are part of"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Deliberately separate from `list` so reading never auto-marks (an AI can browse without clearing your unread state).",
    ],
    seeAlso: ["ib message chat list", "ib message chat threads"],
    examples: ["ib message chat mark-read 42", "ib message chat mark-read --tarjous 23"],
  },
  {
    command: "ib message chat delete",
    description:
      "Soft-delete a chat message (DELETE /api/messages/threads/:id/messages/:messageId; sets isDeleted=1, so it vanishes from every read). The author may delete their OWN message only while it is unanswered (no later reply from another participant); a sysadmin/developer may moderate any message in a thread they can access.",
    auth: "any",
    args: [
      { name: "messageId", type: "number", required: true, description: "Message id to delete (the message PK)" },
    ],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId (one match required)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, deleted:true } (+ alreadyDeleted:true if already gone) · { dryRun:true, threadId, wouldDelete:{ messageId, body, senderPersonId } } on --dry-run",
    errors: [
      apiErr(403, "Not the author (and not a developer)", "you can only delete your own messages"),
      apiErr(409, "Already answered", "a message someone replied to after cannot be retracted — delete the newest first"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Soft-delete: the row is kept for audit but is filtered from list/threads/unread (all carry isDeleted=0). There is no hard delete.",
      "--dry-run only issues a GET (thread messages) to echo the target — it works under --read-only and never deletes (the route has no X-Dry-Run guard).",
      "Locate the thread with --thread <id> or --tarjous <id>; a tarjous with multiple threads requires --thread.",
      "Deploy-gated: the DELETE route must be deployed to the target backend before this works.",
    ],
    seeAlso: ["ib message chat send", "ib message chat list"],
    examples: [
      'ib message chat delete 5 --thread 3 --reason "test cleanup"',
      "ib message chat delete 5 --tarjous 23 --dry-run",
    ],
  },
  {
    command: "ib message chat edit",
    description:
      "Edit a chat message's body (PATCH /api/messages/threads/:id/messages/:messageId). Author-only and only while unanswered (no later reply from a different participant). Moderators cannot edit. Sets editedAt, emits message:edited, no-ops if the body is unchanged. --dry-run previews the from→to diff CLIENT-SIDE.",
    auth: "any",
    args: [{ name: "messageId", type: "number", required: true, description: "Message id to edit (the message PK)" }],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "body", type: "string", required: true, description: "New message text (max 4000 chars)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, senderPersonId, body, editedAt, ... } (enriched row) · { messageId, threadId, unchanged:true } on no-op · { dryRun:true, threadId, wouldEdit:{ messageId, from, to } } on --dry-run",
    errors: [
      apiErr(400, "Empty / too-long body", "body is required, max 4000 chars"),
      apiErr(403, "Not the author", "you can only edit your own messages"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      apiErr(409, "Answered or deleted", "you cannot edit a message that was replied to, or a deleted one"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Author-only — no moderator override (rewriting another person's words is worse than deleting).",
      "--dry-run lists the thread to show the diff; it never PATCHes (works under --read-only).",
      "Deploy-gated: the PATCH route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat send", "ib message chat delete"],
    examples: [
      'ib message chat edit 7 --thread 3 --body "korjattu teksti" --reason typo',
      'ib message chat edit 7 --tarjous 23 --body "korjattu" --dry-run',
    ],
  },
  {
    command: "ib message chat restore",
    description:
      "Restore a soft-deleted chat message (POST /api/messages/threads/:id/messages/:messageId/restore; isDeleted=0). The author OR a sysadmin/developer may restore. Idempotent (already-active → alreadyActive:true). Emits message:restored. Find deleted ids with `ib message chat list --deleted`. --dry-run previews CLIENT-SIDE via the deleted list.",
    auth: "any",
    args: [{ name: "messageId", type: "number", required: true, description: "Message id to restore (the message PK)" }],
    flags: [
      { name: "thread", type: "number", description: "Thread id the message belongs to" },
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "{ messageId, threadId, restored:true } (+ alreadyActive:true if not deleted) · { dryRun:true, threadId, wouldRestore:{ messageId } } on --dry-run",
    errors: [
      apiErr(403, "Not the author (and not a developer)", "you can only restore your own messages"),
      apiErr(404, "Thread or message not found", "check the threadId/messageId"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Deleted messages are hidden from the normal list — use `ib message chat list --deleted` to find ids.",
      "--dry-run lists deleted messages to confirm the target; it never restores (works under --read-only).",
      "Deploy-gated: the restore route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat delete", "ib message chat list"],
    examples: [
      "ib message chat restore 7 --thread 3 --reason \"deleted by mistake\"",
      "ib message chat restore 7 --tarjous 23 --dry-run",
    ],
  },
  {
    command: "ib message chat search",
    description:
      "Search your own chat messages by body text (GET /api/messages/search). Scoped to threads you participate in (the participant JOIN is the tenant boundary); non-deleted only; newest first. q min 2 chars; --limit default 50, max 200.",
    auth: "any",
    args: [{ name: "query", type: "string", required: false, description: "Body substring to search for (min 2 chars) — or pass --search" }],
    flags: [
      { name: "search", type: "string", description: "Search query (alias for the <query> positional)" },
      { name: "limit", type: "number", default: "50", description: "Max results (server max 200)" },
    ],
    outputShape:
      "ListEnvelope<{ messageId, threadId, contextType, contextId, senderPersonId, body, createdAt, personFirstName, personLastName }>",
    errors: [
      apiErr(400, "Query too short", "q must be at least 2 characters"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Only your own threads are searched — the participant JOIN is the tenant boundary.",
      "Substring (LIKE) match; literal % / _ in the query are matched literally.",
      "Deploy-gated: the /search route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message chat list", "ib message chat threads"],
    examples: [
      'ib message chat search "betoni"',
      'ib message chat search "ajoyhteys" --limit 20',
    ],
  },
  // ─── message support (4) ──────────────────────────────────────────────────
  {
    command: "ib message support inbox",
    description:
      "Support triage queue: support threads escalated by operators, newest first. Developer-only (isSystemAdmin / isDeveloper). Filter by lifecycle status. Projects GET /api/messages/support/inbox into the list envelope.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", default: "open", description: "open | resolved | all", allowed: ["open", "resolved", "all"] },
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "{ items: SupportThreadRow[], nextCursor: null, count, truncated }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--status must be open|resolved|all" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Read a thread's messages with `ib message chat list <threadId>` and reply with `ib message chat send <threadId> --body ...` (a support thread is a normal messageThread admins can read).",
    ],
    seeAlso: ["ib message chat list", "ib message support resolve"],
    examples: [
      "ib message support inbox",
      "ib message support inbox --status all --limit 50",
    ],
  },
  {
    command: "ib message support mine",
    description:
      "Your own company's support threads (audience='support', owned by your active company), newest first. The operator-facing companion to the developer-only inbox — any member of the owning company may list them. Filter by lifecycle status. Projects GET /api/messages/support/mine into the list envelope; each row carries a caller-scoped unreadCount.",
    flags: [
      { name: "status", type: "string", default: "open", description: "open | resolved | all", allowed: ["open", "resolved", "all"] },
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "{ items: SupportThreadRow[], nextCursor: null, count, truncated }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--status must be open|resolved|all" },
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(404, "Route not deployed", "the /support/mine backend may not be deployed yet"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Read a thread's messages with `ib message chat list <threadId>` and reply with `ib message chat send <threadId> --body ...`. Open (or append to) a new escalation with `ib message support contact`.",
    ],
    seeAlso: ["ib message support contact", "ib message chat list"],
    examples: [
      "ib message support mine",
      "ib message support mine --status all --limit 50",
    ],
  },
  {
    command: "ib message support contact",
    description:
      "Open (or append to) a support thread escalating a tarjous (pumppuRequest) or keikka to the platform. Any authenticated user. A REAL write — honours the read-only write-lock. --dry-run resolves CLIENT-SIDE (prints the payload, never POSTs). Reply later with `ib message chat send <threadId> --body ...`.",
    auth: "any",
    mutates: true,
    dryRunKind: "client",
    flags: [
      { name: "tarjous", type: "number", description: "pumppuRequestId this escalation is about" },
      { name: "keikka", type: "number", description: "keikkaId this escalation is about" },
      { name: "body", type: "string", required: true, description: "The message to support" },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape:
      "{ threadId, message } on success. With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "Provide exactly one of --keikka / --tarjous (positive integer) and a non-empty --body" },
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Exactly one of --keikka / --tarjous selects the context; --keikka wins if both are passed.",
      "reply with: ib message chat send <threadId> --body ...",
    ],
    seeAlso: ["ib message chat send", "ib message support inbox"],
    examples: [
      'ib message support contact --tarjous 23 --body "Provider not responding — please intervene"',
      'ib message support contact --keikka 5012 --body "Wrong worksite assigned" --dry-run',
    ],
  },
  {
    command: "ib message support resolve",
    description:
      "Mark a support thread resolved, or --reopen it back to open. Developer-only (isSystemAdmin / isDeveloper). A REAL write (PATCH) — blocked under --read-only (exit 3). --dry-run previews the body client-side without sending.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "threadId", type: "number", description: "support messageThread id" }],
    flags: [
      { name: "reopen", type: "boolean", description: "Set status back to open instead of resolved" },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
    ],
    outputShape:
      "{ threadId, status } on success. With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "threadId must be a positive number" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the threadId via `ib message support inbox`"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib message support inbox", "ib message chat list"],
    examples: [
      "ib message support resolve 42",
      "ib message support resolve 42 --reopen",
    ],
  },
  // ─── message thread (5) ──────────────────────────────────────────────────────
  {
    command: "ib message thread archive",
    description:
      "Archive a thread (POST /api/messages/threads/:id/archive). Sets archivedAt — the thread becomes read-only; send/edit/restore then 409. Idempotent (already archived → alreadyArchived:true). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, archived:true } (+ alreadyArchived:true if already archived)",
    errors: [
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.",
      "Archived thread is read-only — send/edit/restore return 409 until reopened.",
      "Idempotent: archiving an already-archived thread returns alreadyArchived:true (no error).",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldArchive:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the archive route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread reopen", "ib message chat send"],
    examples: [
      "ib message thread archive 3 --reason \"case closed\"",
      "ib message thread archive --tarjous 23",
    ],
  },
  {
    command: "ib message thread reopen",
    description:
      "Reopen an archived thread (POST /api/messages/threads/:id/reopen). Clears archivedAt so messages can be sent again. Idempotent (already open → alreadyOpen:true). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, archived:false } (+ alreadyOpen:true if already open)",
    errors: [
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.",
      "Idempotent: reopening an already-open thread returns alreadyOpen:true (no error).",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldReopen:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the reopen route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread archive", "ib message chat send"],
    examples: [
      "ib message thread reopen 3 --reason \"new information\"",
      "ib message thread reopen --tarjous 23",
    ],
  },
  {
    command: "ib message thread rename",
    description:
      'Set or clear the thread title (PATCH /api/messages/threads/:id; body { title }). Title max 200 chars; empty string clears it (sets to NULL). Manager-gated: owning-company admin or sysadmin/developer. Requires the messageThread.title migration to have run on the DB before the rename route is deployed.',
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "title", type: "string", required: true, description: 'New thread title (max 200 chars; "" clears)' },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, title } (title is null when cleared)",
    errors: [
      apiErr(400, "Title too long", "max 200 characters"),
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.",
      'Pass --title "" to clear the title (sets messageThread.title = NULL). ' + clearNote("--title"),
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldRename:{...} } and never PATCHes — works under --read-only.",
      "Deploy-gated: requires the messageThread.title migration (2026-06-21-messageThread-title.sql) to run on the DB BEFORE the rename route deploys — otherwise the backend 500s on missing column.",
    ],
    seeAlso: ["ib message chat thread", "ib message thread archive"],
    examples: [
      'ib message thread rename 3 --title "Betonijerry #42 — toimitus valmis"',
      'ib message thread rename --tarjous 23 --title ""',
    ],
  },
  {
    command: "ib message thread participant add",
    description:
      "Add a colleague to a thread (POST /api/messages/threads/:id/participants; body { personId, role? }). The person must be a member of the thread's owning company (asiakasPerson membership check — the privacy gate; cross-company adds are blocked at 403). Idempotent via MERGE (reactivates a soft-left row). Manager-gated.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "person", type: "number", required: true, description: "personId to add" },
      { name: "role", type: "string", description: "Participant role (customer|pumppu|betoni|lattia|support|provider; default pumppu)" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, personId, role, added:true }",
    errors: [
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(403, "Person not in owning company", "the person must be a member of thread.ownerAsiakasId (asiakasPerson membership — privacy gate; cross-company adds are blocked)"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.",
      "Privacy gate: the added person must be a member of the thread's owning company (asiakasPerson JOIN). Cross-company adds are blocked at 403.",
      "Idempotent: re-adding a participant who left reactivates the row (sets leftAt = NULL) and updates role.",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldAdd:{...} } and never POSTs — works under --read-only.",
      "Deploy-gated: the participants route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread participant remove", "ib message chat thread"],
    examples: [
      "ib message thread participant add 3 --person 42",
      "ib message thread participant add 3 --person 42 --role pumppu --reason \"added to cover\"",
      "ib message thread participant add --tarjous 23 --person 42",
    ],
  },
  {
    command: "ib message thread participant remove",
    description:
      "Soft-remove a participant from a thread (DELETE /api/messages/threads/:id/participants/:personId; sets leftAt = now). Manager-gated: owning-company admin or sysadmin/developer.",
    auth: "any",
    args: [{ name: "threadId", type: "number", required: false, description: "Thread id (omit when using --tarjous)" }],
    flags: [
      { name: "tarjous", type: "number", description: "Resolve the thread from this pumppuRequestId" },
      { name: "person", type: "number", required: true, description: "personId to remove" },
    ],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ threadId, personId, removed:true|false } (removed:false when the participant was already gone)",
    errors: [
      apiErr(403, "Not a manager of this thread", "requires owning-company admin role or sysadmin/developer"),
      apiErr(404, "Thread not found", "check the threadId via `ib message chat threads`"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Manager-gated (canManageThread): owning-company admin/owner, or isSystemAdmin/isDeveloper.",
      "Soft-remove: sets leftAt = now (the row is kept for audit). removed:false when the participant had already left.",
      "--dry-run resolves CLIENT-SIDE (the messages routes honour no X-Dry-Run): it returns { dryRun:true, wouldRemove:{...} } and never DELETEs — works under --read-only.",
      "Deploy-gated: the participants route must be deployed to the target backend.",
    ],
    seeAlso: ["ib message thread participant add", "ib message chat thread"],
    examples: [
      "ib message thread participant remove 3 --person 42 --reason \"left project\"",
      "ib message thread participant remove --tarjous 23 --person 42",
    ],
  },
  // ─── message daily (11) — co-located specs (see import at top) ──────────────
  ...MESSAGE_DAILY_SPECS,
  // ─── message board (6) — co-located specs (see import at top) ───────────────
  ...MESSAGE_BOARD_SPECS,
  // ─── changelog ───────────────────────────────────────────────────────────────
  ...CHANGELOG_SPECS,
  // ─── glossary ────────────────────────────────────────────────────────────────
  {
    command: "ib glossary lookup",
    description: "Resolve a Finnish/colloquial term or synonym to its definition + related commands (DB-backed). Exit 5 if undefined — the miss is recorded for the groomer.",
    auth: "any",
    args: [{ name: "term", type: "string", required: true, description: "A word or synonym, e.g. pumppari" }],
    flags: [],
    outputShape: "single term: { term, synonyms[], definition, relatedCommands:[{command,summary}], relatedEntity } | batch (a,b,c): ListEnvelope<{ term, found, entry }>",
    notes: ["Comma-separated terms (a,b,c) run a batch lookup returning a ListEnvelope of {term,found,entry}; a single term keeps the single-entry shape."],
    errors: [
      { http: 404, exit: 5, meaning: "No entry for the term", remedy: "Try `ib glossary list --search <term>`; the miss is queued for definition" },
      { origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" },
    ],
    examples: ["ib glossary lookup pumppari", "ib glossary lookup betoniasema", "ib glossary lookup loma,saikku,pyhä"],
  },
  {
    command: "ib glossary list",
    description: "List glossary entries; --search filters by term/definition/synonym, --stalest orders least-recently-reviewed first.",
    auth: "any",
    args: [],
    flags: [
      { name: "search", type: "string", description: "Filter by substring" },
      { name: "stalest", type: "number", description: "Return up to N entries, stalest first" },
      { name: "domain", type: "string", description: "Filter to a domain (exact match)" },
      { name: "related", type: "string", description: "Filter to terms whose relatedCommands contain this substring" },
      { name: "terms-only", type: "boolean", description: "Return only {term, synonyms} per entry — the cheap INDEX view (strips definitions); use to discover which terms exist." },
      { name: "needs-review", type: "boolean", description: "Only terms still needing grooming: aiConfidence below the threshold (or unassessed) AND not parked, oldest-first." },
      { name: "max-confidence", type: "number", description: "Threshold for --needs-review (default 90)." },
    ],
    outputShape: "{ items:[{term,synonyms,definition,relatedCommands:[{command,summary}],relatedEntity,domain,lastReviewed,runs,aiConfidence,needsHumanReview}], count, truncated? }",
    notes: [
      "--terms-only is client-side: it strips each row to {term, synonyms} after the server-side filters apply. Use it instead of a full list to discover terms cheaply (the full list returns every definition).",
    ],
    errors: [{ origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" }],
    examples: ["ib glossary list", "ib glossary list --search puomi", "ib glossary list --stalest 10", "ib glossary list --domain vacation", "ib glossary list --terms-only", "ib glossary list --needs-review"],
  },
  {
    command: "ib glossary misses",
    description: "Open lookup misses ranked by frequency — the groomer's queue of undefined terms (developer only).",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [{ name: "top", type: "number", description: "Return up to N" }],
    outputShape: "{ items:[{term,count,firstSeen,lastSeen,status}], count, truncated? }",
    errors: [{ http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" }],
    examples: ["ib glossary misses --top 20"],
  },
  {
    command: "ib glossary dismiss",
    description: "Dismiss an open lookup miss WITHOUT defining the term — for junk/test lookups (developer only). The term re-enters the queue if it is ever looked up again.",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "term", type: "string", required: true, description: "Missed term (as listed by `ib glossary misses`)" }],
    flags: [],
    outputShape: "{ term, dismissed: 1 }; or { dryRun: true, term, wouldDismiss: boolean } with --dry-run",
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { http: 404, exit: 5, meaning: "No OPEN miss for that term", remedy: "Check `ib glossary misses` for the exact term" },
    ],
    examples: [
      "ib glossary dismiss xa4 --reason junk",
      "ib glossary dismiss xa4 --dry-run",
    ],
  },
  {
    command: "ib glossary set",
    description: "Create/update a glossary entry (developer only). UPSERT: creates the term if absent, pass --update-only to require it already exists (404 otherwise). PARTIAL update: only the fields you pass change — omit a flag to KEEP its current value, pass an empty value to CLEAR it. " + clearNote("--synonyms") + " Auto-resolves a matching miss.",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "term", type: "string", required: true, description: "Canonical term" }],
    flags: [
      { name: "definition", type: "string", description: "One-paragraph definition (≤2000). Omit to keep current." },
      { name: "synonyms", type: "string", description: 'Comma-separated aliases incl. inflections. Omit to keep; ' + clearHint("--synonyms") + "." },
      { name: "related", type: "string", description: 'Comma-separated command paths, e.g. "ib person,ib vehicle driver board". Omit to keep; ' + clearHint("--related") + "." },
      { name: "entity", type: "string", description: "Related DB entity, e.g. Person / personId. Omit to keep." },
      { name: "domain", type: "string", description: "Domain grouping (e.g. vacation). Omit to keep." },
      { name: "update-only", type: "boolean", description: "Only update an existing term; do not create a new one (404 if absent)" },
      { name: "from-json", type: "string", description: "Read fields from a JSON object file (or - for stdin); flags override. Keys: definition, synonyms, relatedCommands, relatedEntity, domain, aiConfidence, needsHumanReview. Only keys present in the object are written (others kept, EXCEPT the two assessment fields — see notes)." },
      { name: "add-synonyms", type: "string", description: "Comma-separated synonyms to ADD to the existing list — no full resend. Excl. --synonyms." },
      { name: "remove-synonyms", type: "string", description: "Comma-separated synonyms to REMOVE by name (idempotent). Excl. --synonyms." },
      { name: "append-definition", type: "string", description: "Append a clause to the current definition (single-space join; re-appending identical text is a no-op). Excl. --definition." },
      { name: "ai-confidence", type: "number", description: "Self-assessed completeness/correctness 0–100 (groom rubric). Omit on a human edit to reset the score." },
      { name: "needs-human-review", type: "boolean", description: "Park the term for a human (excludes it from --needs-review); set with a low --ai-confidence when blocked." },
    ],
    outputShape: "{ term, synonyms, definition, relatedCommands, relatedEntity, domain, runs }",
    notes: [
      "PARTIAL (PATCH) semantics: an omitted flag is NOT sent, so the backend preserves the existing value — you can update just one field (e.g. only --synonyms) without re-sending the definition. To CLEAR a field pass an empty value: `--synonyms \"\"` empties the list, `--entity \"\"` blanks it. " + clearNote("--synonyms") + " To OVERWRITE, pass the new value.",
      "Requires the partial-aware backend (COALESCE save proc) deployed; against an older backend an omitted field is still overwritten to empty/null — re-send all fields (or use --from-json) until the backend is updated.",
      "--ai-confidence / --needs-human-review are NOT partial: the backend direct-assigns them, so any write that omits them RESETS the score to null and clears the parked flag (by design — a human edit re-opens the row for grooming). A grooming write must therefore carry aiConfidence EVERY time, via the flag or the --from-json key. Both are read from --from-json since fb#298; before that fix the JSON key was silently dropped and the score wiped.",
      "Append mode (--add-synonyms / --remove-synonyms / --append-definition) edits in place without re-sending the whole field — built for no-filesystem callers (MCP ib_exec, /api/cli/exec) that can't use --from-json. The merge runs server-side and the target term must already exist (404 otherwise). Deploy-gated: against an un-updated backend these flags no-op (the value is preserved, not corrupted).",
      "An append flag COMPOSES with plain overwrite flags for OTHER fields in the same call: `--definition \"new\" --add-synonyms \"x\"` overwrites the definition AND merges the synonym in one request. Only the same-field twin is rejected (exit 4): --definition⊥--append-definition and --synonyms⊥--add/remove-synonyms. Deploy-gated: an un-updated backend drops the plain field instead of composing — until it deploys, set OTHER fields in a separate call.",
    ],
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { http: 404, exit: 5, meaning: "Term not found (with --update-only)", remedy: "Omit --update-only to create the entry" },
      { http: 404, exit: 5, meaning: "append/add/remove on a non-existent term", remedy: "Create the term first (set --definition …); append requires an existing entry" },
      { http: 400, exit: 4, meaning: "definition >2000 chars (the message names the effective length; --append-definition reports the MERGED current+appended length)", remedy: "Shorten the definition" },
      { origin: "client", exit: 4, meaning: "--from-json file is not valid JSON or not readable", remedy: "Check the file path and contents" },
    ],
    examples: ['ib glossary set valumassa --definition "Pumpattava betonimassa." --synonyms "massaa,valua" --related "ib keikka" --reason "groom"', 'ib glossary set puomi --synonyms "boom,nollakone,puomiton" --reason "add synonyms only"', 'ib glossary set pumppari --definition "Updated def." --update-only --reason "groom"', 'ib glossary set loma --from-json loma.json --reason "groom"', 'ib glossary set puomi --add-synonyms "nollakone" --reason "add one synonym"', 'ib glossary set tilaus --append-definition "Convention: UI says tilaus, code says keikka." --reason "append clause"'],
  },
  {
    command: "ib glossary import",
    description: "Bulk create/update glossary entries from a JSON array file (developer only). Avoids shell argv mangling of Finnish ä/ö.",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "file", type: "string", required: true, description: "JSON array file of {term, definition, synonyms?, relatedCommands?, relatedEntity?, domain?, aiConfidence?, needsHumanReview?} objects (or - for stdin)" }],
    flags: [
      { name: "update-only", type: "boolean", description: "Only update existing terms; never insert" },
    ],
    outputShape: "{ results: [{term, ok, error?}], ok, failed }",
    notes: [
      "Each entry must have a `term` field; entries missing it are counted as failed.",
      "Synonyms and relatedCommands may be arrays (arrays are accepted and converted to a comma list internally) or comma-separated strings.",
      "Avoids shell argv mangling of Finnish ä/ö — pass UTF-8 JSON instead of quoting on the command line.",
      "There is no --ai-confidence flag here, so a per-entry `aiConfidence` key is the ONLY way a bulk groom can carry its score. The backend resets that field on any write that omits it, so an entry without the key is stored unscored (and re-queued for grooming). Entry keys are honoured since fb#298 — before that fix import silently wiped the score of every term it touched.",
    ],
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { origin: "client", exit: 4, meaning: "File is not valid JSON or root is not an array", remedy: "Check the file path and JSON syntax" },
    ],
    examples: ['ib glossary import terms.json --reason "bulk groom"', 'echo \'[{"term":"loma","definition":"Vapaapaiva"}]\' | ib glossary import - --reason "test"'],
  },
  {
    command: "ib glossary delete",
    description: "Delete a glossary entry (developer only).",
    tier: "developer",
    auth: "any",
    mutates: true,
    writeFlags: true,
    dryRunKind: "client",
    args: [{ name: "term", type: "string", required: true, description: "Canonical term" }],
    flags: [],
    outputShape:
      "{ deleted: 0|1 } — rows removed; or { dryRun: true, term, wouldDelete: <entry>|null } with --dry-run",
    errors: [{ http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" }],
    notes: [
      "--dry-run resolves CLIENT-SIDE: it previews the entry that WOULD be deleted (via the miss-free ?search= endpoint) and never issues the DELETE — safe even before the backend guard deploys (the backend DELETE route ignored X-Dry-Run before this fix, so a --dry-run silently destroyed the entry).",
    ],
    examples: [
      "ib glossary delete obsolete-term --reason cleanup",
      "ib glossary delete obsolete-term --dry-run",
    ],
  },
  {
    command: "ib glossary lint",
    description: "Audit entries: dead relatedCommands, near-duplicate terms, empty fields (developer only).",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [
      { name: "strict", type: "boolean", description: "Exit 1 if any warn-level finding exists (for CI)" },
      { name: "suggest-related", type: "boolean", description: "Also emit stale-related suggestions: specs mentioning a term/synonym/entity but not yet linked (info-level)" },
    ],
    outputShape: "ListEnvelope<{ term, issue: 'dead-related'|'near-duplicate'|'empty-definition'|'no-anchor'|'synonym-collision'|'stale-related', detail, severity }>",
    errors: [{ http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" }],
    notes: [
      "--suggest-related is a grooming aid (fb#110): it proposes command paths whose path/flags/description mention the term (whole-word, >=4 chars), ranked path>flag>description, capped 6/term — review before adding, false positives are possible.",
    ],
    examples: ["ib glossary lint", "ib glossary lint --suggest-related"],
  },
  // ─── task (6) ────────────────────────────────────────────────────────────
  // Recurring operator tasks (weekly/monthly, human or AI executor) over
  // /api/tasks. Hybrid due-since + done-log: DUE when nextDueAt <= now;
  // complete (done/skipped) advances nextDueAt by the cadence; failed only
  // logs so the task stays due. ALL developer-gated server-side this phase.
  {
    command: "ib task list",
    description:
      "List recurring operator tasks, most-overdue first (nextDueAt ASC). Developer-only. Default scope: active tasks; --due narrows to tasks due NOW (nextDueAt <= now); --inactive includes deactivated ones. The daily AI runner sweeps `ib task list --due --executor ai --agent claude`.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "due", type: "boolean", description: "Only tasks due now (nextDueAt <= now)" },
      { name: "executor", type: "string", description: "human | ai", allowed: [...TASK_EXECUTORS] },
      { name: "agent", type: "string", description: "claude | hermes — recommendedAgent filter (AI tasks)", allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "Only tasks assigned to this personId" },
      { name: "asiakas", type: "number", description: "Only tasks scoped to this company (asiakasId); internal/global tasks have asiakasId NULL" },
      { name: "inactive", type: "boolean", description: "Include deactivated tasks (default: active only)" },
      { name: "limit", type: "number", default: "50", description: "Max rows (cap 200)" },
      { name: "offset", type: "number", default: "0", description: "Pagination offset" },
    ],
    outputShape:
      "{ items: TaskRow[], nextCursor: null, count, truncated? } — TaskRow = { taskId, title, instructions, skillRef, executor, recommendedAgent, assigneePersonId, asiakasId, cadenceUnit, cadenceCount, nextDueAt, lastDoneAt, active, feedbackId, ... }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--executor must be human|ai; --agent must be claude|hermes; --assignee/--asiakas/--limit/--offset must be integers" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib task list --due",
      "ib task list --due --executor ai --agent claude",
      "ib task list --executor human --assignee 10",
      "ib task list --asiakas 8 --inactive",
    ],
  },
  {
    command: "ib task get",
    description: "Fetch one recurring task by id (developer-only).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [],
    outputShape:
      "The full task row { taskId, title, instructions, skillRef, executor, recommendedAgent, assigneePersonId, asiakasId, cadenceUnit, cadenceCount, nextDueAt, lastDoneAt, active, feedbackId, createdAt, updatedAt, ... }",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib task list", "ib task log"],
    examples: ["ib task get 7"],
  },
  {
    command: "ib task add",
    description:
      "Create a recurring task (developer-only; a write). executor=human tasks surface in the morning report for a person to complete; executor=ai tasks are picked up by the daily runner when --skill names a workspace skill (--agent claude) — skill-less or hermes tasks wait and surface in the morning report. Default first due = immediately; the first completion sets the rhythm (nextDueAt = completion time + cadence, rolling, not day-anchored).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    flags: [
      { name: "title", type: "string", description: "Task title, max 200 chars (required)" },
      { name: "executor", type: "string", description: "human | ai (required)", allowed: [...TASK_EXECUTORS] },
      { name: "cadence", type: "string", description: "<count>/<unit>, unit day|week|month, count 1-120, e.g. 1/month or 2/week. Required unless --once." },
      { name: "once", type: "boolean", description: "SINGLE-SHOT task: completing it (done/skipped) retires the task (active=0) instead of rolling nextDueAt, so it is done forever. Mutually exclusive with --cadence. Pair with --first-due for a 'chase this in N months' reminder. A `failed` completion still leaves it due — a failed attempt has not done the thing." },
      { name: "instructions", type: "string", description: "Freetext checklist for humans / prompt context for the AI runner" },
      { name: "skill", type: "string", description: "Workspace skill the AI runner invokes (e.g. cleanup-docs); omit for human tasks" },
      { name: "agent", type: "string", description: "claude | hermes — recommended AI executor tier (claude = code/advanced, hermes = light local-LLM work)", allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "Human assignee personId" },
      { name: "asiakas", type: "number", description: "Company (asiakasId) the task is scoped to; omit = internal/global" },
      { name: "first-due", type: "string", description: "First due date (YYYY-MM-DD or today/tomorrow); default: due immediately" },
      { name: "feedback", type: "number", description: "cliFeedback id this task graduated from (provenance link)" },
      { name: "from-json", type: "string", description: "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Keys: title, executor, instructions, skill, agent, assignee, asiakas, cadence, first-due, feedback. An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the way to pass --instructions prose containing quotes on Windows PowerShell." },
    ],
    outputShape: "{ taskId } on success (HTTP 201). With --dry-run: { dryRun:true, wouldWrite:{...} } (server-side preview).",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--title, --executor (human|ai) and one of --cadence (<count>/<unit>) or --once are required (from flags or --from-json); --agent must be claude|hermes; unit must be day|week|month, count 1-120; --assignee/--asiakas/--feedback must be integers" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "DEPLOY-GATED (fb#534): --once needs a later puminet5api version. Against an older backend it is rejected with `cadenceUnit must be one of: day, week, month` — a clean 400, not a silent recurring task.",
      "--once is NOT a --from-json key. It takes no value, so `\"once\": true` would exit 4 and `\"once\": \"true\"` would be silently dropped, creating a recurring task you believe is one-off (the fb#541 class). Pass --once on argv alongside --from-json.",
    ],
    examples: [
      'ib task add --title "Open purchase invoices review" --executor human --assignee 10 --cadence 1/month --reason "monthly finance check"',
      'ib task add --title "Docs prune sweep" --executor ai --agent claude --skill cleanup-docs --cadence 1/month --reason "ops hygiene"',
      'ib task add --title "KU-oy invoice chase" --executor human --asiakas 8 --cadence 2/week --first-due tomorrow --reason "per-company cadence"',
      'ib task add --title "Activate Hyvinkaan Betoni (non-compete lapses)" --executor human --once --first-due 2026-11-02 --reason "one-time activation"',
    ],
  },
  {
    command: "ib task complete",
    description:
      "Complete a task: append a done-log row and advance nextDueAt = now + cadence (rolling). --skipped also advances; --failed only logs — the task STAYS due (the runner's failure path). AI completions pass --agent so the log distinguishes human vs AI. Developer-only; a write.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [
      { name: "notes", type: "string", description: "Result summary stored on the log row" },
      { name: "skipped", type: "boolean", description: "Log outcome=skipped (advances nextDueAt); mutually exclusive with --failed" },
      { name: "failed", type: "boolean", description: "Log outcome=failed — nextDueAt untouched, task stays due" },
      { name: "agent", type: "string", description: "claude | hermes — set when an AI completes the task", allowed: [...TASK_AGENTS] },
    ],
    outputShape:
      "{ logId, task } (task = the updated row; nextDueAt advanced unless --failed). With --dry-run: { dryRun:true, wouldComplete:{ taskId, outcome, advancesNextDue } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--skipped and --failed are mutually exclusive; --agent must be claude|hermes" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib task list`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      'ib task complete 7 --notes "reviewed 12 invoices, 2 chased" --reason "monthly run"',
      'ib task complete 7 --agent claude --notes "cleanup-docs pruned 9 files" --reason "recurring-task runner"',
      'ib task complete 7 --failed --agent claude --notes "skill errored: …"',
    ],
  },
  {
    command: "ib task set",
    description:
      'Partial update of a recurring task (developer-only; a write). Omit a flag to KEEP the current value; pass "" to CLEAR a text field (--instructions/--skill/--agent). ' + clearNote("--instructions") + ' --deactivate soft-retires the task (history kept); --activate restores it. --next-due overrides the due date without logging a completion.',
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [
      { name: "title", type: "string", description: "New title" },
      { name: "instructions", type: "string", description: 'New instructions ("" clears)' },
      { name: "skill", type: "string", description: 'New skillRef ("" clears)' },
      { name: "executor", type: "string", description: "human | ai", allowed: [...TASK_EXECUTORS] },
      { name: "agent", type: "string", description: 'claude | hermes ("" clears)', allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "New assignee personId" },
      { name: "asiakas", type: "number", description: "New company scope (asiakasId)" },
      { name: "cadence", type: "string", description: "<count>/<unit>, unit day|week|month, count 1-120. Mutually exclusive with --once." },
      { name: "once", type: "boolean", description: "Convert to a SINGLE-SHOT task (cadenceUnit=once): completion retires it instead of rolling nextDueAt. This is the conversion path for a task already faking 'once' as --cadence 120/month. cadenceCount is left untouched — it is meaningless for a one-off." },
      { name: "next-due", type: "string", description: "Override nextDueAt (YYYY-MM-DD or today/tomorrow)" },
      { name: "activate", type: "boolean", description: "Reactivate; mutually exclusive with --deactivate" },
      { name: "deactivate", type: "boolean", description: "Soft-retire the task (active=0)" },
    ],
    outputShape: "The full updated task row. With --dry-run: { dryRun:true, wouldWrite:{...} } (server-side preview).",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "provide at least one field; --activate/--deactivate and enum values as documented; --assignee/--asiakas must be integers" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      'ib task set 7 --cadence 2/month --reason "cadence tuning"',
      'ib task set 7 --deactivate --reason "task retired"',
      'ib task set 7 --skill "" --reason "no automation yet — back to morning-report surfacing"',
    ],
  },
  {
    command: "ib task log",
    description: "Completion history for one task, newest first (developer-only). agent non-null = AI completion; outcome failed rows explain why a task is still due.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [{ name: "limit", type: "number", default: "50", description: "Max rows (cap 200)" }],
    outputShape:
      "{ items: LogRow[], nextCursor: null, count, truncated? } — LogRow = { logId, taskId, doneAt, donePersonId, agent, outcome, notes }",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib task complete", "ib task get"],
    examples: ["ib task log 7", "ib task log 7 --limit 10"],
  },
];

/**
 * The canonical catalogue of every `ib` subcommand. Summaries and details are
 * now DB-served via `/api/cli/command-catalog` (`ib reference detail get`); the
 * source-backed tiers have been removed.
 */
export const COMMAND_SPECS: CommandSpec[] = BASE_COMMAND_SPECS;
