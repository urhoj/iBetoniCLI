// legal specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec, CommandArg, CommandFlag, CommandError } from "../../output/help.js";
import { clearHint, apiErr, limitErr, COMMON_AUTH_ERRORS, LEGAL_DEV_ERRORS, intParseErr, PERSON_PARSE_ERR } from "./shared.js";

/** The `--owner` parse-guard row shared by status/versions/diff. Note: `save`'s
 *  own --owner carries a DIFFERENT remedy ("omit for a global document") and
 *  stays a separate inline call — do not fold it into this constant. */
const OWNER_PARSE_ERR = intParseErr("--owner", "pass a positive ownerAsiakasId");

/** The positional+alias pair shared by every `ib legal` command that names a
 *  document type (fb#1036). Single-sourced so a wording fix cannot land on four
 *  of the five — the same reason `shared.ts` exports DRIVER_DATE_ARG/FLAG.
 *  `get` keeps its own literal: its positional also accepts a documentId. */
const TYPE_NAME_ARG: CommandArg = { name: "typeName", type: "string", required: false, description: "Document type name (see ib legal types; or pass --type)" };
const TYPE_ALIAS_FLAG: CommandFlag = { name: "type", type: "string", description: "Document type name (alias for the positional)" };

/** The two client-side rejections of `resolveTypeNameTarget`, shared by every
 *  command taking the pair above. TWO rows because the matcher is a substring:
 *  a lone "missing document type" row never matched the conflict message, so
 *  five commands fell through to the generic hint on it (fb#1221). */
const TYPE_TARGET_ERRORS: CommandError[] = [
  { origin: "client", exit: 4, match: "missing document type", meaning: "Neither the positional nor --type was given", remedy: "pass <typeName> positionally or via --type (the positional is canonical; both are allowed only when they agree)" },
  { origin: "client", exit: 4, match: "pass only one", meaning: "The positional and --type name different types", remedy: "pass only one of them, or make them agree" },
];

export const LEGAL_SPECS: CommandSpec[] = [

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
    args: [TYPE_NAME_ARG],
    flags: [
      TYPE_ALIAS_FLAG,
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
      ...TYPE_TARGET_ERRORS,
      apiErr(404, "No active document of this type", "check ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal types", "ib legal versions"],
    examples: ["ib legal show BETONIJERRY_TOS", "ib legal show --type BETONIJERRY_TOS", "ib legal show TOS --meta", "ib legal show TOS --language en"],
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
      PERSON_PARSE_ERR,
      OWNER_PARSE_ERR,
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
    args: [TYPE_NAME_ARG],
    flags: [
      TYPE_ALIAS_FLAG,
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
    errors: [...TYPE_TARGET_ERRORS, OWNER_PARSE_ERR, ...COMMON_AUTH_ERRORS],
    seeAlso: ["ib legal get", "ib legal diff", "ib legal drafts", "ib legal activate"],
    examples: ["ib legal versions TOS", "ib legal versions --type TOS", "ib legal versions TOS --status draft", "ib legal versions BETONIJERRY_TOS", "ib legal versions TOS --language en"],
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
        required: false,
        description: "legalDocuments.documentId, or a typeName (UPPER_SNAKE, see ib legal types) resolving to its active version; or pass --type for the typeName form",
      },
    ],
    flags: [{ name: "type", type: "string", description: "Document type name (alias for the positional's typeName form)" }],
    outputShape:
      "{documentId, documentTypeId, typeName, version, title, status, markdownContent, isActive, ...}",
    notes: [
      "The document body is the `markdownContent` field — NOT `content` or `body`. Reading `.content` returns undefined (an empty body) with no error: a silent false-negative. `ib legal show` uses the same field name.",
    ],
    errors: [
      { origin: "client", exit: 4, meaning: "Argument is neither a numeric documentId nor a typeName, or neither the positional nor --type was given", remedy: "pass a documentId from ib legal list, or a typeName like PRIVACY (positionally or via --type)" },
      apiErr(404, "Document not found / type has no active document", "list ids via ib legal versions <typeName>"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib legal versions", "ib legal diff"],
    examples: ["ib legal get 12", "ib legal get PRIVACY", "ib legal get --type PRIVACY"],
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
      { origin: "client", exit: 4, match: ["pass either", "only applies with --type", "provide two positive documentids"], meaning: "Neither two documentIds nor --type supplied (or both), or --owner without --type", remedy: "pass <a> <b> OR --type <name>" },
      OWNER_PARSE_ERR,
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
      intParseErr("--owner", "pass a positive ownerAsiakasId (omit for a global document)"),
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
    args: [TYPE_NAME_ARG],
    flags: [
      TYPE_ALIAS_FLAG,
      { name: "doc-version", type: "string", description: "Only acceptances of this version string (NOT --version — that is the global CLI version flag)" },
      { name: "limit", type: "number", default: "500", description: "Max rows (cap 500)" },
    ],
    outputShape:
      "ListEnvelope<{personId, firstName, lastName, email, acceptedVersion, acceptedAt}> & {typeName, personSettingTypeId, truncated?}",
    errors: [
      ...TYPE_TARGET_ERRORS,
      limitErr("pass a positive integer; this command caps at 500 — narrow with `--doc-version` rather than raising the cap"),
      apiErr(400, "Type has no personSettingTypeId mapping", "fix the legalDocumentTypes row first"),
      apiErr(404, "Unknown document type", "ib legal types"),
      ...LEGAL_DEV_ERRORS,
    ],
    seeAlso: ["ib legal status", "ib legal types"],
    examples: ["ib legal acceptances BETONIJERRY_TOS", "ib legal acceptances --type BETONIJERRY_TOS", "ib legal acceptances TOS --doc-version 2.0"],
  },
  {
    command: "ib legal accept",
    description:
      "Record YOUR OWN acceptance of the current active version of a type. DEVELOPER TESTING AID, gated client-side to developer/sysadmin tokens — real consent is a human action recorded via the betoni.online / betonijerry.fi UI flows. The backend endpoint is self-only: you can never accept on someone else's behalf. --reason required unless --dry-run.",
    permissions: ["isSystemAdmin or isDeveloper (client-side gate)"],
    tier: "developer",
    args: [
      TYPE_NAME_ARG,
    ],
    flags: [
      TYPE_ALIAS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape: "{success} | dry-run: {dryRun: true, wouldAccept: {...}, validation}",
    errors: [
      { origin: "client", exit: 3, meaning: "Not a developer/sysadmin token (client-side gate)", remedy: "use a developer account" },
      ...TYPE_TARGET_ERRORS,
      { origin: "client", exit: 4, match: ["--reason", "personSettingTypeId"], meaning: "Missing --reason, or the type has no personSettingTypeId mapping so acceptance cannot be tracked", remedy: "pass --reason; check the type mapping with ib legal types" },
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
      "ib legal accept --type TOS --dry-run",
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
    outputShape: "the created legalDocumentTypes row | dry-run: {dryRun: true, wouldCreateType: {...}, validation}",
    errors: [
      { origin: "client", exit: 4, match: "missing required flag: --reason", meaning: "Missing --reason / invalid or duplicate typeName / settingTypeId unknown or already mapped", remedy: "check ib legal types; pass --reason unless --dry-run" },
      intParseErr("--sort-order", "pass a non-negative integer list position", 0),
      intParseErr("--setting-type-id", "pass a valid personSettingTypeId"),
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
    args: [TYPE_NAME_ARG],
    flags: [
      TYPE_ALIAS_FLAG,
      { name: "display-name", type: "string", description: "Human-readable name (max 100)" },
      { name: "description", type: "string", description: "Short description (max 200)" },
      { name: "sort-order", type: "number", description: "List position" },
      { name: "setting-type-id", type: "number", description: "personSettingTypeId for acceptance tracking (must exist in personSettingTypes and not be mapped to another type)" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    outputShape: "the updated legalDocumentTypes row | dry-run: {dryRun: true, wouldUpdateType: {typeName, fields}, validation}",
    errors: [
      ...TYPE_TARGET_ERRORS,
      { origin: "client", exit: 4, match: "missing required flag: --reason", meaning: "Missing --reason / no field flags / settingTypeId unknown or already mapped to another type", remedy: "pass at least one field flag and --reason unless --dry-run" },
      intParseErr("--sort-order", "pass a non-negative integer list position", 0),
      intParseErr("--setting-type-id", "pass a valid personSettingTypeId"),
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
      'ib legal type update --type TOS_EN --display-name "Terms of Service v2" --dry-run',
    ],
  },
];
