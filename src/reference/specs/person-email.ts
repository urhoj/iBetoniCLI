// person-email specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, COMMON_AUTH_ERRORS, permErrors, REASON_REQUIRED_FLAG } from "./shared.js";

export const PERSON_EMAIL_SPECS: CommandSpec[] = [
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
      { name: "from-json", type: "string", description: "Read this command's flags from a JSON object in a file (or - for stdin) — keys are the flag names (e.g. body, title). The shell-safe route for prose on Windows PowerShell, which splits a quote-bearing or multi-line value into separate arguments. An explicitly-typed flag wins over the file, and a REQUIRED flag may be supplied this way instead of on argv." },
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
    flags: [REASON_REQUIRED_FLAG],
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
    flags: [REASON_REQUIRED_FLAG],
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
    flags: [REASON_REQUIRED_FLAG],
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
];
