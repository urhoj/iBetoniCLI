// attachment specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec, CommandError } from "../../output/help.js";
import { apiErr, limitErr, COMMON_AUTH_ERRORS, ATTACHMENT_ENTITY_FLAGS, ATTACHMENT_ROW, ENTITY_FLAG_NOTE, DEPLOY_NOTE, LIMIT_500_FLAG, intParseErr } from "./shared.js";

/**
 * The `<attachmentId>` positional parse-guard row (fb#893): all six id-taking
 * commands parse through `parseId`, so a malformed id exits 4 client-side with
 * `invalid attachmentId: "…" — expected a positive integer` instead of a
 * backend 404/500. Carries a `match` so the failure never inherits an
 * unrelated matchless exit-4 row's remedy (fb#385 hint resolution), e.g.
 * download's "Output file exists".
 */
const INVALID_ATTACHMENT_ID_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: "attachmentId",
  meaning: "invalid <attachmentId> positional, rejected locally before any request",
  remedy: "attachmentId must be a positive integer — verify it with `ib attachment list` or `ib attachment search`",
};

/**
 * The entity-id flag parse-guard row (fb#905): the `--keikka <id>` …
 * `--message <id>` family registered by addEntityFlags on
 * list/attach/detach/upload/register, plus the hidden `--asiakas` alias of
 * `--customer`, all parse through intFlag now, where a bare `Number` coercer
 * used to send NaN down the wire (or, for detach, fold NaN-vs-NaN into a
 * confusing conflict). The matches are the FULL per-flag intFlag messages,
 * derived from ATTACHMENT_ENTITY_FLAGS (the ASIAKAS_FLAG_ERR/fb#908
 * rationale): a common tail like "must be an integer >= 1" shadows sibling
 * guards — it demonstrably swallowed limitErr's remedy for `--limit` on
 * `attachment list`, whose cappedInt emits the same tail.
 */
const ENTITY_FLAG_PARSE_ERR: CommandError = {
  origin: "client",
  exit: 4,
  match: [
    ...ATTACHMENT_ENTITY_FLAGS.map((f) => `--${f.name} must be an integer >= 1`),
    "--asiakas must be an integer >= 1",
  ],
  meaning: "an entity id flag (--keikka/--vehicle/…/--message, or the hidden --asiakas alias of --customer) is not an integer >= 1, rejected locally before any request",
  remedy: "pass the entity id as a positive integer",
};

export const ATTACHMENT_SPECS: CommandSpec[] = [
  // ─── attachment (12) ─────────────────────────────────────────────────────
  {
    command: "ib attachment list",
    description: "List attachments linked to ONE entity, with group/type names on every row. Rows for companies the caller is not a member of are filtered out (keikka lists use the keikka-party check instead).",
    auth: "any",
    flags: [
      ...ATTACHMENT_ENTITY_FLAGS,
      { name: "group", type: "string", description: "Filter by group (NAME or id — `ib attachment types`)" },
      { name: "type", type: "string", description: "Filter by type (NAME or id — `ib attachment types`)" },
      LIMIT_500_FLAG,
    ],
    outputShape: `ListEnvelope<${ATTACHMENT_ROW}>`,
    errors: [ENTITY_FLAG_PARSE_ERR, limitErr("pass a positive integer; this command caps at 500, so narrow by entity rather than raising the cap"), apiErr(403, "Not a member of the target entity's company", "check the active company (ib auth whoami)"), ...COMMON_AUTH_ERRORS],
    notes: [ENTITY_FLAG_NOTE, "No SAS URLs in list rows — use `ib attachment get` for a download URL.", DEPLOY_NOTE],
    seeAlso: ["ib attachment get", "ib attachment types", "ib attachment search"],
    examples: ["ib attachment list --keikka 9001", "ib attachment list --vehicle 53 --group kuva", "ib attachment list --request 1234"],
  },
  {
    command: "ib attachment get",
    aliases: ["ib attachment show"],
    description: "One attachment: full metadata, group/type names, and a 1-hour read-SAS blobUrl for downloading the bytes directly from Azure.",
    auth: "any",
    args: [{ name: "attachmentId", type: "number", description: "attachments.attachmentId" }],
    flags: [],
    outputShape: `${ATTACHMENT_ROW} & { fileFolder, blobUrl }`,
    errors: [INVALID_ATTACHMENT_ID_ERR, apiErr(404, "Attachment not found (or deleted)", "verify attachmentId"), apiErr(403, "No membership in the owner company or any keikka party", "check the active company"), ...COMMON_AUTH_ERRORS],
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
    errors: [INVALID_ATTACHMENT_ID_ERR, apiErr(404, "Attachment not found", "verify attachmentId"), { origin: "client", exit: 4, match: "Refusing to overwrite", meaning: "Output file exists", remedy: "pass --force or --out <other path>" }, ...COMMON_AUTH_ERRORS],
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
    errors: [ENTITY_FLAG_PARSE_ERR, { origin: "client", exit: 4, match: ["Cannot read file", "max 500 MB", "Exactly one entity flag"], meaning: "File unreadable / bad entity flags", remedy: "check the path and pass exactly one entity flag" }, { origin: "client", exit: 6, meaning: "Azure PUT failed", remedy: "re-run; SAS expires in 1h" }, apiErr(403, "Not a member of the target entity's company", "check active company"), ...COMMON_AUTH_ERRORS],
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
    errors: [ENTITY_FLAG_PARSE_ERR, intParseErr("--size", "pass the file size in bytes as an integer", 0), apiErr(403, "fileFolder outside the active company / not a member of the target", "mint via upload-url; check active company"), apiErr(400, "Missing required field / unknown entity", "see required flags"), ...COMMON_AUTH_ERRORS],
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
    errors: [INVALID_ATTACHMENT_ID_ERR, ENTITY_FLAG_PARSE_ERR, apiErr(404, "Attachment not found", "verify attachmentId"), apiErr(403, "No membership on attachment or target", "check active company"), ...COMMON_AUTH_ERRORS],
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
      { name: "entity", type: "string", required: false, description: "keikka|vehicle|person|customer|worksite|sijainti|tuote|bug-report|request|offer|message (omit when using a --<entity> flag instead)" },
    ],
    flags: [...ATTACHMENT_ENTITY_FLAGS],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ ok: true, attachmentId, detached: entity } | { dryRun: true, wouldDetach: {...} }",
    errors: [INVALID_ATTACHMENT_ID_ERR, ENTITY_FLAG_PARSE_ERR, apiErr(403, "Not owner company or missing manager role", "switch to the owner company; need Admin/KeikkaHandler/AttachmentHandler/Owner"), apiErr(404, "Attachment not found", "verify attachmentId"), { origin: "client", exit: 4, match: ["entity to unlink", "Conflicting entity", "entity flag allowed", "Unknown entity"], meaning: "No entity given, conflicting positional + flag, or unknown entity word", remedy: "name the entity once — positional word OR a --<entity> flag" }, ...COMMON_AUTH_ERRORS],
    notes: ["Name the entity as a positional word (`detach 4711 keikka`) OR an attach-style flag (`detach 4711 --keikka 9001`) — the flag's id is ignored since detach only needs the entity name (though it must still parse as an integer >= 1).", "Audited via ChangeTracker on the previously-linked entity's timeline.", DEPLOY_NOTE],
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
    errors: [INVALID_ATTACHMENT_ID_ERR, { origin: "client", exit: 4, match: "--liita-laskuun must be", meaning: "--liita-laskuun is not 0 or 1, rejected locally before any request", remedy: "pass 0 (not invoice-linked) or 1 (invoice-linked)" }, apiErr(403, "Not owner company / missing manager role / liitaLaskuun without lasku-admin", "use an account with lasku or asiakas admin role on the owner company"), apiErr(404, "Attachment not found", "verify attachmentId"), ...COMMON_AUTH_ERRORS],
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
    outputShape: "{ ok: true, attachmentId, deleted: true, blobDeleted } | { dryRun: true, wouldDelete: { attachmentId, blobName, origFileName } }",
    errors: [INVALID_ATTACHMENT_ID_ERR, { origin: "client", exit: 4, match: "--reason", meaning: "Missing --reason", remedy: "pass --reason 'why'" }, apiErr(400, "Missing X-Action-Reason header", "pass --reason"), apiErr(403, "Not owner company or missing manager role", "switch to the owner company"), apiErr(404, "Attachment not found or already deleted", "verify attachmentId"), ...COMMON_AUTH_ERRORS],
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
      LIMIT_500_FLAG,
    ],
    outputShape: `ListEnvelope<${ATTACHMENT_ROW}>`,
    errors: [limitErr("pass a positive integer; this command caps at 500, so narrow the search term rather than raising the cap"), ...COMMON_AUTH_ERRORS],
    notes: ["Tenant comes from the JWT — there is no company parameter.", "No text and no --missing lists every active attachment in the company (capped at --limit; `truncated:true` signals more).", DEPLOY_NOTE],
    seeAlso: ["ib attachment list", "ib attachment detach"],
    examples: ["ib attachment search", "ib attachment search kuormakirja", "ib attachment search --missing"],
  },
];
