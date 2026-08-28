// lifecycle specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearHint, clearNote, apiErr, permErrors, ASIAKAS_FLAG_ERR, PERSON_SCOPE_404_REMEDY, REASON_REQUIRED_FLAG, intParseErr } from "./shared.js";

/** The `--person` / `--contact-type` parse-guard pair every customer/worksite person add/remove leaf shares. */
const PERSON_PARSE_ERR = intParseErr("--person", "pass a positive personId");
const CONTACT_TYPE_PARSE_ERR = intParseErr("--contact-type", "pass a valid contactPersonTypeId (1, 2, 3, or 5)");

export const LIFECYCLE_SPECS: CommandSpec[] = [

  // ─── v1.0.1 additions: customer/worksite/person lifecycle (11) ──────────
  {
    command: "ib customer delete",
    description: "Delete a customer (asiakas). Requires --reason; --dry-run available.",
    permissions: ["auth.page.asiakas.edit"],
    args: [{ name: "asiakasId", type: "number", description: "asiakasId to delete" }],
    flags: [
      REASON_REQUIRED_FLAG,
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ added: { asiakasId, personId } } or { dryRun: true, wouldCreate: { asiakasId, personId, contactPersonTypeId } }",
    errors: [
      intParseErr("--asiakas", "pass a positive asiakasId"),
      PERSON_PARSE_ERR,
      CONTACT_TYPE_PARSE_ERR,
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: { asiakasId, personId } } or { dryRun: true, wouldDelete: { asiakasId, personId } }",
    errors: [
      intParseErr("--asiakas", "pass a positive asiakasId"),
      PERSON_PARSE_ERR,
      CONTACT_TYPE_PARSE_ERR,
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
      REASON_REQUIRED_FLAG,
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ added: { tyomaaId, personId } } or { dryRun: true, wouldCreate: { tyomaaId, personId, contactPersonTypeId } }",
    errors: [
      intParseErr("--worksite", "pass a positive tyomaaId"),
      PERSON_PARSE_ERR,
      CONTACT_TYPE_PARSE_ERR,
      ...permErrors("auth.page.tyomaa.edit"),
    ],
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ removed: { tyomaaId, personId } } or { dryRun: true, wouldDelete: { tyomaaId, personId } }",
    errors: [
      intParseErr("--worksite", "pass a positive tyomaaId"),
      PERSON_PARSE_ERR,
      CONTACT_TYPE_PARSE_ERR,
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ personId, name, email, ... } (re-fetched) · with --get-or-create adds reused:boolean · dry-run: { dryRun: true, wouldCreate: ... }",
    errors: [
      ASIAKAS_FLAG_ERR,
      // The required-field half is a CLIENT guard (`create requires: …`) and
      // never reaches the backend, so the two causes need separate rows — as one
      // http row the local half was unreachable (fb#280/fb#668 class). Twin of
      // the `sijainti create` row.
      { origin: "client", exit: 4, match: "create requires:", meaning: "A required field is missing (the message names which)", remedy: "pass the flags the message names — --first and --last are required; email is optional" },
      // Two more exit-4 guards this command owns. Missed by the af8553e audit
      // pass — its method (guard messages vs documented rows) is only as good as
      // the sweep, and these two were in the tail.
      { origin: "client", exit: 4, match: "--global and --asiakas are mutually exclusive", meaning: "Both --global and --asiakas given — contradictory owner directives", remedy: "pass one: --global for a self-managing person (ownerAsiakasId null), or --asiakas <id> to own it" },
      { origin: "client", exit: 4, match: "already in use by a person you cannot access", meaning: "--get-or-create matched an email owned by a company you cannot see, so it can neither reuse nor create", remedy: "find the owner with `ib person search --my-companies`, or create with a different email" },
      apiErr(400, "Duplicate email without --get-or-create", "add --get-or-create to reuse an existing visible person, or use a different email"),
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ ok: true, updated: { personId } } or { dryRun: true, wouldUpdate: { personId, ... } }",
    errors: [
      // Same client-side guard as `worksite update` (fb#668) — not shadowing
      // anything here, but equally unreachable as an `http: 400` row.
      { origin: "client", exit: 4, match: "requires at least one field", meaning: "No fields to update", remedy: "pass at least one typed flag (--first/--last/--phone/--email/--memo) or a --body/--from-json patch" },
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
      REASON_REQUIRED_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "always",
    outputShape: "{ personId, ownerAsiakasId } or { dryRun: true, wouldSetOwner: { personId, from, to } }",
    errors: [
      ASIAKAS_FLAG_ERR,
      { origin: "client", exit: 4, match: "--reason", meaning: "Missing --reason", remedy: "pass --reason 'why'" },
      apiErr(403, "Not allowed to change this person's owner", "see the authz rules above (developer/self/company-admin)"),
      apiErr(404, "Person not found IN SCOPE", PERSON_SCOPE_404_REMEDY),
      { origin: "client", exit: 4, match: "exactly one of --global", meaning: "Bad flags", remedy: "provide exactly one of --global / --asiakas and a --reason" },
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
      REASON_REQUIRED_FLAG,
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
];
