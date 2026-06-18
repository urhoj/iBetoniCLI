/**
 * Domain primer for betoni.online — the *what*, not the *how*.
 *
 * `specs.ts` teaches an AI how to call each command; this file teaches it what
 * it is operating on (the business, the multi-tenant model, the Finnish entity
 * vocabulary). Both ride along in the single artifact an AI ingests at session
 * start: `ib reference dump` embeds {@link DOMAIN_OVERVIEW} and a DB-fetched
 * glossary as top-level keys, and `ib --help` renders the same via
 * {@link renderDomainHelp}. One source of truth → the primer can never drift
 * from the CLI it describes.
 */
import type { CallerTier } from "../tier.js";

/** One-paragraph description of the platform, tenancy model, and BetoniJerry. */
export const DOMAIN_OVERVIEW =
  "betoni.online is a concrete-delivery management platform for Finnish " +
  "concrete pumping and delivery companies. Work centres on `keikka` records " +
  "— individual concrete delivery/pumping jobs scheduled to a worksite within " +
  "a date/time window. Data is multi-tenant: every result is scoped to the " +
  "active company (asiakas) via the ownerAsiakasId derived from your token, " +
  "and `ib company switch` changes what you can see. BetoniJerry is an " +
  "umbrella tenant (asiakasId 1349) grouping independent concrete-pumping " +
  "service providers together with the customers who registered through " +
  "betonijerry.fi (their ownerAsiakasId is 1349). Many field names and status " +
  "values are in Finnish.";

/**
 * Offline one-line blurbs per command DOMAIN, for `ib commands` (domain index)
 * and computed group help. This is CLI-structure documentation (available
 * without a backend) — distinct from the DB-backed vocabulary glossary
 * (`ib glossary`), which owns synonyms/definitions and is fetched at runtime.
 */
export const DOMAIN_BLURBS: Record<string, string> = {
  keikka: "Concrete delivery/pumping orders — the central entity.",
  customer: "Customer companies you deliver to.",
  worksite: "Construction sites where concrete is delivered.",
  sijainti: "Geocoded locations — depots, plants, destinations.",
  vehicle: "Pump and mixer trucks.",
  person: "System users — drivers, admins, office staff.",
  driver: "Day-driver board: who drives which vehicle on a date.",
  company: "The tenant company your token acts as (multi-tenancy).",
  schedule: "Date-scoped views of keikkas: today / a day / a week.",
  stats: "Aggregated delivery statistics.",
  perf: "SQL slow-query monitoring (developer).",
  jerry: "BetoniJerry RFQ marketplace: requests, offers, confirmation.",
  message: "Chat threads, the announcement board, and daily grid notes.",
  attachment: "Files (photos/PDFs) linked to entities via Azure Blob.",
  legal: "Versioned legal documents and per-person acceptances.",
  validate: "Company and person readiness validation profiles.",
  log: "Field-level audit trail (changeTracker).",
  cache: "Redis cache inspection/invalidation (developer).",
  bug: "User-filed bug reports.",
  feedback: "Quiet CLI/AI friction sink for proposals.",
  glossary: "Domain glossary — resolve a term/synonym to its meaning + commands.",
  ohje: "UI help-text content behind HelperIcon.",
  schema: "SQL schema introspection (developer).",
  ai: "/ai assistant conversations (developer).",
  changelog: "Dev changelog entries (developer).",
  reference: "Machine-readable CLI catalogue (dump / detail).",
  auth: "Login, logout, token, company switch.",
  doctor: "Aggregated CLI/connectivity health report.",
};

export const domainBlurb = (domain: string): string | null => DOMAIN_BLURBS[domain] ?? null;

/**
 * Guidance for an AI consuming this CLI on WHEN to file feedback. Surfaced in
 * `ib --help` and embedded in `ib reference dump` so it rides along with the
 * primer the AI ingests at session start. Intent: proactive, immediate feedback
 * (no need to ask the user) that makes the CLI better over time — the channel is
 * `ib feedback create`, which is silent, low-cost, and works under --read-only.
 */
export const FEEDBACK_GUIDANCE = {
  summary:
    "If you are an AI using this CLI, file feedback with `ib feedback create` " +
    "PROACTIVELY and IMMEDIATELY — you do NOT need to ask the user first. It is " +
    "low-cost, safe, and works even under --read-only — no GitHub issue and no " +
    "spam back to you or the user (only the maintainer gets a quiet heads-up). " +
    "This is the primary way the CLI improves, so err on the side of filing.",
  fileWhenYou: [
    "hit ANY error or an unexpected exit code",
    "had to try several strategies because the help/docs were unclear, missing, or wrong",
    "found a command, flag, or its output confusing or harder to use than expected",
    "could not find a command for something the user asked for that this CLI probably should do (a capability gap)",
    "noticed an inconsistency between commands (naming, behaviour, flags, or output shape)",
  ],
  how:
    "Use --kind bug for breakage, --kind improvement for gaps/ideas. Attach " +
    "--command (what you ran) and --error (the message) so it can be reproduced.",
};

export interface Topic {
  id: string;
  title: string;
  body: string;
}

/** Concept guides for cross-cutting knowledge, surfaced by `ib help <id>` and embedded in `ib reference dump`. */
export const TOPICS: Topic[] = [
  {
    id: "roles",
    title: "Role model (two layers)",
    body:
      "`customer person list` row `roleTypeId` only echoes the --role FILTER (null = base membership), NOT the person's role set. For the full per-company roles use `ib person role list <personId> --asiakas <id>`. One `person role grant` adds exactly ONE setting (no bundle). Resolve role NAME<->typeId and see access tiers with `ib person role explain <name>`.",
  },
  {
    id: "jerry-lifecycle",
    title: "BetoniJerry RFQ lifecycle",
    body:
      "Request: draft -> open (provider inbox). Offer: draft -> pending (provider `offer send`) -> accepted (CUSTOMER `offer accept`, siblings rejected) -> confirmed (PROVIDER `offer confirm`, which BUILDS a keikka). Customer PII is masked to providers until their offer is accepted. Use `ib jerry check-address` to debug 'no offers'.",
  },
  {
    id: "write-safety",
    title: "Write safety: dry-run, idempotency, reason, read-only",
    body:
      "--dry-run is SERVER-side on most writes (sends X-Dry-Run; if the handler doesn't honour it the write PERSISTS -- never dry-run against an endpoint whose guard isn't deployed). It is CLIENT-side (never sends) on `vehicle update`, `ohje update`, `feedback create/resolve`. --idempotency-key dedupes retries (24h). --reason is written to the audit log (required by delete/grant/revoke). --read-only / IB_READ_ONLY blocks every non-GET (exit 3) AND the persisted `company switch` / `auth switch` (they rotate+persist the JWT outside the API client); the ephemeral global `--company <id>` stays allowed (nothing persisted). Read-only refusals carry `code: \"READ_ONLY_BLOCKED\"` (with statusCode 0) in the stderr envelope — distinguishing them from a server-side HTTP 403, which shares exit 3. `feedback create` is exempt (meta request).",
  },
  {
    id: "exit-codes",
    title: "Process exit codes",
    body:
      "0 ok (incl. --help/--version); 1 generic failure: bare `ib`/bare group help render, `auth login` failure, `doctor` aggregate not-ok, unexpected runtime errors; 2 auth (HTTP 401); 3 permission (403, incl. read-only-mode refusals — envelope code READ_ONLY_BLOCKED); 4 validation (4xx incl. 400/409/429, AND parser usage errors — unknown command/flag, missing required arg/option — emitted as the JSON error envelope with code USAGE); 5 not-found (404); 6 server (5xx); 7 network. Every error path emits the JSON envelope on stderr. Each command's --help ERRORS section lists exit code + HTTP status.",
  },
  {
    id: "multi-tenancy",
    title: "Multi-tenancy & company context",
    body:
      "Every read/write is scoped to the active company's ownerAsiakasId, derived from your JWT. `ib company switch --to <id>` persists a new active company; the global `--company <id>` runs ONE command in another company's context via an ephemeral (non-persisted) switch (it is named --company because many subcommands have their own --asiakas flag). BetoniJerry is the umbrella tenant asiakasId 1349.",
  },
  {
    id: "log",
    title: "Audit trail (changeTracker) reading",
    body:
      "Every tracked write produces field-level rows: who (personId/personName, impersonatedByPersonName when impersonated), when, fieldName old→new, description, and the --reason the writer supplied (X-Action-Reason). Reads: `ib log entity <type> <id>` for one entity (keikka folds in its keikkaBetoni rows; person/customer/keikka/vehicle/worksite also have `log` shortcuts). Admin-wide views: `log latest` (newest N), `log range --from --to` (changes MADE in the window), `log by-entity-date` (changes affecting deliveries DATED in the window — the grid drawer's view). `log user [personId]` = changes BY a person. entityType catalog: `ib log types` (offline). Gates: entity reads need company membership (personAvailability: admin); latest/range/by-entity-date and other-person user reads need an admin role (asiakasAdmin/laskuAdmin/sysadmin). Aggregate views return reason/impersonator only after the 2026-06 backend deploy; nulls before that. NOT in changeTracker: email-send fallback events when the sender had no personId/ownerAsiakasId (stepLog-only edge case).",
  },
  {
    id: "attachments",
    title: "Attachment flow (local vs remote)",
    body:
      "LOCAL: `attachment upload <file> --<entity> <id>` does mint->PUT->register in one step; `attachment download <id>` saves to disk. REMOTE (/api/cli/exec, MCP): upload/download are DENIED (they would touch the SERVER's filesystem). Instead: `attachment upload-url --name f.ext` -> PUT the bytes yourself (header x-ms-blob-type: BlockBlob) -> `attachment register ...`; for downloads run `attachment get <id>` and fetch blobUrl yourself (expires in 1h). Groups/types are NAMES or ids — legend: `ib attachment types`. delete is irreversible (blob hard-delete) and needs --reason.",
  },
];

/**
 * Module-level holder for a DB-fetched glossary, stashed by `bin/ib.ts` before
 * help renders so `renderDomainHelp` can include it without requiring network
 * access at render time. When empty, the GLOSSARY section is omitted.
 */
let helpGlossary: Array<{ term: string; synonyms: string[] }> = [];

export function setHelpGlossary(
  g: Array<{ term: string; synonyms: string[] }>
): void {
  helpGlossary = g;
}

/**
 * Render the primer as a fixed-section text block for `ib --help`. Mirrors the
 * parse-friendly style of `formatHelp` (uppercase section headers, two-space
 * indent) so an AI sees a consistent layout across root and per-command help.
 * The GLOSSARY section is rendered from the `helpGlossary` holder (DB-fetched
 * at startup by `bin/ib.ts`) — omitted entirely when the holder is empty
 * (offline / tokenless).
 *
 * The `tier` parameter is accepted for API compatibility (callers pass
 * `getCallerTier()`) but is not used for glossary filtering now that the
 * glossary is DB-backed and tier-scoped at the server level.
 */
export function renderDomainHelp(_tier: CallerTier = "developer"): string {
  const glossary = helpGlossary;
  const lines: string[] = [];
  lines.push("");
  lines.push("ABOUT");
  lines.push(`  ${DOMAIN_OVERVIEW}`);
  if (glossary.length > 0) {
    lines.push("");
    lines.push("GLOSSARY (term + synonyms; run `ib glossary lookup <term>` for the definition)");
    for (const g of glossary) {
      lines.push(
        g.synonyms && g.synonyms.length > 0
          ? `  ${g.term} (${g.synonyms.join(", ")})`
          : `  ${g.term}`
      );
    }
  }
  lines.push("");
  lines.push("FILING FEEDBACK (AI users — be proactive)");
  lines.push(`  ${FEEDBACK_GUIDANCE.summary}`);
  lines.push("  File `ib feedback create` whenever you:");
  for (const t of FEEDBACK_GUIDANCE.fileWhenYou) {
    lines.push(`    - ${t}`);
  }
  lines.push(`  ${FEEDBACK_GUIDANCE.how}`);
  lines.push("");
  lines.push("OUTPUT");
  lines.push(
    "  All commands: JSON on stdout; errors as a JSON envelope on stderr. Exit codes: 0 ok ·"
  );
  lines.push(
    "    1 generic · 2 auth · 3 permission · 4 validation · 5 not-found · 6 server · 7 network"
  );
  lines.push("    — details: `ib help exit-codes`.");
  lines.push("");
  lines.push("DISCOVER");
  lines.push(
    "  First run: `ib auth login` (opens browser) or set IB_TOKEN=<jwt>; verify with `ib doctor`."
  );
  lines.push(
    "  Commands (cheap, offline): `ib commands` — domain index (~5 KB); `ib commands <domain>`"
  );
  lines.push(
    "    for one group's commands (e.g. `ib commands keikka`); `ib commands --all` for the full"
  );
  lines.push("    flat list; filters --reads / --mutations / --permission <substr>.");
  lines.push(
    "  Full machine-readable specs: `ib reference dump` (entire surface) or `ib reference dump"
  );
  lines.push("    <domain>` for one group. Single command: `ib <command> --help`.");
  lines.push(
    "  Concept guides: `ib help <topic>` — " + TOPICS.map((t) => t.id).join(", ") + "."
  );
  return lines.join("\n");
}
