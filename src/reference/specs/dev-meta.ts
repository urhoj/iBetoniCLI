// dev-meta specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, authErrors, permErrors } from "./shared.js";

export const DEV_META_SPECS: CommandSpec[] = [

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
    // No hand-written 500 row here: `permErrors` → `authErrors` already appends
    // the identical "Backend error / retry with --verbose" (fb#668). Two
    // byte-identical rows at one status is not a choice the matcher can make —
    // it takes the first and the second is simply dead weight in the dump.
    errors: permErrors("developer access (isSystemAdmin or isDeveloper)"),
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
];
