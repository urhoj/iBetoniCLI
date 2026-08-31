// auth specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { apiErr, ASIAKAS_FLAG_ERR, intParseErr } from "./shared.js";

export const AUTH_SPECS: CommandSpec[] = [
  // ─── auth (6) ────────────────────────────────────────────────────────────
  {
    command: "ib auth login",
    description:
      "Open the system browser to authorize this CLI via OAuth 2.1 + PKCE and persist credentials to ~/.ibetoni/credentials.json (mode 0600). Sessions are kept PER ENDPOINT (fb#855): a login with --endpoint <other> becomes the active session and PARKS the previous endpoint's session instead of replacing it, and every later call under --endpoint <url> uses the session minted for that url — so a prod login and a local-dev login coexist with no re-login when switching.",
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
      "Revoke the refresh token server-side (best-effort) and forget the local session of the ACTIVE endpoint — or of --endpoint <url> — leaving other endpoints' sessions in place (fb#855); the credentials file is removed with the last session.",
    auth: "any",
    flags: [],
    outputShape: "no stdout output; exit 0 on success",
    errors: [
      { origin: "client", exit: 1, meaning: "I/O error", remedy: "check file permissions" },
    ],
    examples: ["ib auth logout", "ib auth logout --endpoint http://127.0.0.1:8080"],
  },
  {
    command: "ib auth whoami",
    aliases: ["ib auth status"],
    description:
      "One-shot orientation for the active session: who/where you are, what you can do (tier), and where else you can act (companies). Decoded from the JWT, so it works for IB_TOKEN sessions too (not just the on-disk creds store). An EXPIRED file session self-heals (refresh, incl. the OAuth refresh-token grant) or exits 2 — a dead session is caught here, not on your next write. Run it first.",
    auth: "any",
    flags: [],
    outputShape:
      "{ personId, email?, activeCompany: { asiakasId, name, betoniJerryUmbrella? }, tier: 'developer'|'admin'|'standard', companies: { asiakasId, roles }[], endpoint, source: 'file'|'env', readOnly, tokenExpiresAt?, tokenExpired?, refreshed?, impersonating?, sessions?: { endpoint, personId, ownerAsiakasId, ownerAsiakasName, expiresAt, active }[] } — `tier` is the discovery/capability gate; `companies` are the `company switch` targets (no name in the JWT — use `ib company list` for names); `source:'env'` = IB_TOKEN (non-refreshable); `refreshed: true` = the stored JWT had expired and whoami self-healed the session before reporting; `sessions` (file sessions only) lists every stored per-endpoint session, active first — the `--endpoint`s that need no login (fb#855).",
    errors: [
      { origin: "client", exit: 2, match: "not logged in", meaning: "Not logged in", remedy: "ib auth login first (or set IB_TOKEN); under --endpoint the message names the exact `ib auth login --endpoint <url>` (fb#1040) and lists the sessions you already hold" },
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
        match: "not logged in",
        meaning: "Not logged in (no session for the endpoint — under --endpoint the lookup is per-endpoint, fb#855)",
        remedy: "ib auth login first; under --endpoint the message names the exact `ib auth login --endpoint <url>` (fb#1040)",
      },
      {
        origin: "client",
        exit: 2,
        // refresh.ts joins both failures as "… — session unrecoverable, run
        // `ib auth login`"; the match disambiguates from the not-logged-in row.
        match: "session unrecoverable",
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
      // Three exit-4 guards, one documented row: as the sole matchless client
      // row it answered ALL of them, so "Already impersonating — run --end
      // first" was told to START a session (fb#668 class). The already-active
      // case is the opposite instruction, so it gets its own row.
      // The guard is protecting more than a retarget: without it the second
      // start overwrites the STASHED ADMIN profile with the current impersonation
      // profile, so `--end` would "restore" you to the impersonated identity and
      // the admin session would be unrecoverable.
      { origin: "client", exit: 4, match: "already impersonating", meaning: "A session is already active — starting a second would overwrite the stashed admin profile, so --end could no longer restore you", remedy: "end the current one first with `ib auth impersonate --end` (or `--extend` to keep it), then start the new target" },
      { origin: "client", exit: 4, match: ["no active impersonation session", "provide a target personid"], meaning: "No active session (--end/--extend), or neither personId nor --email given", remedy: "start with `ib auth impersonate <personId>`" },
      { origin: "client", exit: 4, match: "invalid personId", meaning: "The personId positional is not a positive integer, rejected locally before any request", remedy: "pass a positive integer personId, or use --email" },
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
      intParseErr("--months", "pass a positive number of months (default 6, max 12)"),
      ASIAKAS_FLAG_ERR,
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(403, "Not a system admin", "requires isSystemAdmin"),
      apiErr(424, "Fennoa credentials missing for the target company", "add apiKeys rows (ownerAsiakasId + apiKeySourceId 16, USER/KEY) or use --asiakas 8"),
      apiErr(500, "Backend or Fennoa API error", "retry with --verbose"),
    ],
    notes: ["Live two-phase Fennoa fetch (list + per-invoice detail); 'open' = total_due > 0 — the Fennoa API has no unpaid filter."],
    examples: ["ib fennoa purchases", "ib fennoa purchases --asiakas 8 --months 2", "ib fennoa purchases --all --refresh"],
  },
];
