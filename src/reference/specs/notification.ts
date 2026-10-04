// notification specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { COMMON_AUTH_ERRORS, FROM_JSON_FLAGS_FLAG, apiErr } from "./shared.js";

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
      FROM_JSON_FLAGS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ success, reason:'SENT'|'NO_DEVICES'|'DELIVERY_FAILED', personId, name, devicesTargeted, messageUuid?, successCount?, failureCount?, hint? } | { dryRun:true, wouldSend:{ personId, name, title, body, deviceCount } } (with --dry-run)",
    errors: [
      apiErr(400, "Invalid request: missing --title/--body, bad --person, ambiguous name, or non-object --data (NOT 'no devices' — that is a 200, see notes)", "supply --title/--body and an unambiguous --person"),
      apiErr(403, "Not Admin/HR on the active company", "`--company <ownerId>` where you are admin/HR for one command, or `ib company switch` to persist"),
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
      "Send ONE email to a person (resolved in your company) or to raw addresses (comma-separated, all on To). Admin/HR/developer-gated server-side. Pick the sender with --from-brand (betoni=noreply@ibetoni.fi default, betonijerry=noreply@betonijerry.fi bypassing the demo reroute, juha=juha.urho@ibetoni.fi owner-only); --bcc adds blind copies (repeatable). One of --body/--html/--html-body required; --dry-run previews the resolved recipient + sender without sending.",
    tier: "admin",
    permissions: [
      "company admin (isAsiakasAdmin), HR admin (isHRAdmin), or global developer/sysadmin (server-enforced)",
    ],
    args: [
      {
        name: "recipient",
        type: "string",
        description:
          "personId, a name resolved within your company, or one or more raw email addresses (contain '@'), comma-separated",
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
          "Sender identity: betoni (default, noreply@ibetoni.fi), betonijerry (noreply@betonijerry.fi), or juha (juha.urho@ibetoni.fi — owner's own account only)",
      },
      {
        name: "bcc",
        type: "string",
        description:
          "Blind-copy address(es) — repeatable or comma-separated (e.g. your own, to keep a copy of what you sent)",
      },
      FROM_JSON_FLAGS_FLAG,
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ sent:true, to, from, bcc?, subject } | { dryRun:true, wouldSend:{ to, from, bcc?, subject, hasHtml } } (--dry-run); to/bcc are arrays when several",
    errors: [
      apiErr(
        400,
        "Missing --subject or body, --html with --html-body, bad --from-brand, invalid or >50 recipient/--bcc addresses, or recipient has no email on file",
        "fix that input"
      ),
      // The CLI always sends exactly one of personId/email, so this 400 only comes
      // from a backend that rejects the email ARRAY — deploy skew, not input (fb#2224).
      apiErr(
        400,
        "Backend predates multi-recipient send",
        "deploy skew: backend predates several recipients/--bcc (fb#2221, puminet5api 1.46.4) — deploy + swap, or one address per call; nothing was sent",
        "exactly one of personId or email"
      ),
      {
        origin: "client",
        exit: 4,
        match: "several recipients must all be email addresses",
        meaning: "A name/personId among several emails",
        remedy: "list only emails, or send to the person alone",
      },
      apiErr(
        403,
        "Not Admin/HR/developer, or --from-brand juha used by anyone but its owner (or under impersonation)",
        "`--company <ownerId>` where you are admin/HR for one command, or `ib company switch` to persist, or use a developer/sysadmin token"
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
      "Recipient: '@' values are raw addresses (comma-separated → one mail, all on To, visible to each other); else a personId or a name resolved in your company (0 matches → exit 5, >1 → exit 4).",
      "A SendGrid failure returns 422 with the provider message (the CDN masks origin 5xx) — NOT a caller auth/validation error.",
      "--from-brand betonijerry sends as noreply@betonijerry.fi via a DIRECT send that bypasses the BetoniJerry demo-mode reroute — so a deliverability/spam test actually reaches the target inbox.",
    ],
    seeAlso: ["ib notification fcm send", "ib person email list"],
    examples: [
      "ib notification email send web-xxxxx@srv1.mail-tester.com --subject 'deliverability test' --body 'testing' --from-brand betonijerry --reason 'spam check'",
      "ib notification email send 'Juha Urho' --subject Tiedote --html ./notice.html",
      "ib notification email send 5351 --subject Raportti --html-body '<h1>Aamuraportti</h1><p>…</p>' --reason 'morning report over MCP'",
      "ib notification email send asiakas@example.fi --subject Tarjous --html ./tarjous.html --from-brand juha --bcc juha.urho@ibetoni.fi",
      "ib notification email send 'a@x.fi,b@x.fi' --from-json ./mail.json --bcc me@x.fi --dry-run",
    ],
  },
];
