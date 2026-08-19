// notification specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, COMMON_AUTH_ERRORS } from "./shared.js";

export const NOTIFICATION_SPECS: CommandSpec[] = [

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
];
