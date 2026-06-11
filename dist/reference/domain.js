/**
 * Domain primer for betoni.online — the *what*, not the *how*.
 *
 * `specs.ts` teaches an AI how to call each command; this file teaches it what
 * it is operating on (the business, the multi-tenant model, the Finnish entity
 * vocabulary). Both ride along in the single artifact an AI ingests at session
 * start: `ib reference dump` embeds {@link DOMAIN_OVERVIEW} + {@link GLOSSARY}
 * as top-level keys, and `ib --help` renders the same via
 * {@link renderDomainHelp}. One source of truth → the primer can never drift
 * from the CLI it describes.
 */
/** One-paragraph description of the platform, tenancy model, and BetoniJerry. */
export const DOMAIN_OVERVIEW = "betoni.online is a concrete-delivery management platform for Finnish " +
    "concrete pumping and delivery companies. Work centres on `keikka` records " +
    "— individual concrete delivery/pumping jobs scheduled to a worksite within " +
    "a date/time window. Data is multi-tenant: every result is scoped to the " +
    "active company (asiakas) via the ownerAsiakasId derived from your token, " +
    "and `ib company switch` changes what you can see. BetoniJerry is an " +
    "umbrella tenant (asiakasId 1349) grouping independent concrete-pumping " +
    "service providers together with the customers who registered through " +
    "betonijerry.fi (their ownerAsiakasId is 1349). Many field names and status " +
    "values are in Finnish.";
/** Core entities and recurring field names an AI will meet in the data. */
export const GLOSSARY = [
    {
        term: "keikka",
        definition: "A concrete delivery/pumping order: one job delivered to a worksite in a date/time window. The central entity (`ib keikka …`).",
    },
    {
        term: "asiakas / customer",
        definition: "A customer company you deliver to (`ib customer …`).",
    },
    {
        term: "attachment",
        definition: "A file (photo/PDF/document) in Azure Blob, linked to entities via the generic attachments table — keikka, vehicle, person, customer, worksite, sijainti, tuote, bug report, Jerry request/offer. Managed with `ib attachment …`; bytes move directly between you and Azure via 1h SAS URLs.",
    },
    {
        term: "työmaa / worksite",
        definition: "A construction site where concrete is delivered (`ib worksite …`).",
    },
    {
        term: "sijainti",
        definition: "A geocoded location — depot, plant, or customer destination (`ib sijainti …`).",
    },
    {
        term: "vehicle",
        definition: "A pump or mixer truck (`ib vehicle …`).",
    },
    {
        term: "person",
        definition: "A system user: driver, admin, etc. (`ib person …`).",
    },
    {
        term: "company (tenant)",
        definition: "The active company your token acts on — the multi-tenancy boundary (`ib company …`).",
    },
    {
        term: "schedule",
        definition: "Date-scoped views of keikkas: today / a given day / a week (`ib schedule …`).",
    },
    {
        term: "tila",
        definition: "Finnish for \"status\" — keikka rows carry the numeric keikkaTilaId: " +
            "-1 Uusi tilaus (new) · 0 Luonnos (draft) · 1 Kesken (in progress) · " +
            "2 Lähetetty (sent) · 3 Käsittelyssä (being handled) · 4 Toimitusvalmis (ready for delivery) · " +
            "5 Toimitus meneillään (delivery ongoing) · 6 Toimitus epäonnistui (delivery failed) · " +
            "7 Epäonnistui (failed) · 8 Peruttu (cancelled) · 9/12/13 Toimitettu (delivered) · " +
            "10 Poistettu (deleted) · 100 Valmis (complete/closed) · 11/200 Järjestelmätilaus (system row, do not edit). " +
            "Source of truth: GET /api/tila/list.",
    },
    {
        term: "ownerAsiakasId",
        definition: "Tenant-owner id derived from your JWT; scopes every list/read.",
    },
    {
        term: "BetoniJerry",
        definition: "A request-for-quote marketplace for concrete pumping: customers post requests, provider companies bid, the winner is confirmed into a keikka. Also an umbrella tenant (asiakasId 1349) for providers and betonijerry.fi-registered customers (`ib jerry …`).",
    },
    {
        term: "tarjouspyyntö / pumppuRequest",
        definition: "A BetoniJerry request for a concrete pump (the RFQ). Lifecycle: draft → open → accepted → confirmed (`ib jerry request …`).",
    },
    {
        term: "tarjous / pumppuOffer",
        definition: "A provider's bid (price, availability, terms) on a pumppuRequest (`ib jerry request offers`).",
    },
    {
        term: "varikko",
        definition: "A pumping provider's depot — a sijainti with a delivery radius. Enrolled in BetoniJerry per-varikko via jerryActiveUntil (`ib sijainti set-jerry`).",
    },
    {
        term: "jerryActiveUntil",
        definition: "sijainti column gating a varikko's BetoniJerry enrolment: future/sentinel datetime = active, NULL = not enrolled, past = expired.",
    },
    {
        term: "changes / muutoshistoria",
        definition: "Field-level audit trail (changeTracker table): every tracked write stores who/when/old→new and the --reason header, scoped per tenant (ownerAsiakasId). Read with `ib changes ...` or the per-entity `history` subcommands.",
    },
    {
        term: "validate",
        definition: "Company-setup validation profiles: jerry (BetoniJerry provider readiness) and betoni (betoni.online customer setup) — per-company pass/fail checklists with Finnish details.",
    },
];
/**
 * Guidance for an AI consuming this CLI on WHEN to file feedback. Surfaced in
 * `ib --help` and embedded in `ib reference dump` so it rides along with the
 * primer the AI ingests at session start. Intent: proactive, immediate feedback
 * (no need to ask the user) that makes the CLI better over time — the channel is
 * `ib feedback create`, which is silent, low-cost, and works under --read-only.
 */
export const FEEDBACK_GUIDANCE = {
    summary: "If you are an AI using this CLI, file feedback with `ib feedback create` " +
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
    how: "Use --kind bug for breakage, --kind improvement for gaps/ideas. Attach " +
        "--command (what you ran) and --error (the message) so it can be reproduced.",
};
/** Concept guides for cross-cutting knowledge, surfaced by `ib help <id>` and embedded in `ib reference dump`. */
export const TOPICS = [
    {
        id: "roles",
        title: "Role model (two layers)",
        body: "`customer person list` row `roleTypeId` only echoes the --role FILTER (null = base membership), NOT the person's role set. For the full per-company roles use `ib person role list <personId> --asiakas <id>`. One `person role grant` adds exactly ONE setting (no bundle). Resolve role NAME<->typeId and see access tiers with `ib role explain <name>`.",
    },
    {
        id: "jerry-lifecycle",
        title: "BetoniJerry RFQ lifecycle",
        body: "Request: draft -> open (provider inbox). Offer: draft -> pending (provider `offer send`) -> accepted (CUSTOMER `offer accept`, siblings rejected) -> confirmed (PROVIDER `offer confirm`, which BUILDS a keikka). Customer PII is masked to providers until their offer is accepted. Use `ib jerry check-address` to debug 'no offers'.",
    },
    {
        id: "write-safety",
        title: "Write safety: dry-run, idempotency, reason, read-only",
        body: "--dry-run is SERVER-side on most writes (sends X-Dry-Run; if the handler doesn't honour it the write PERSISTS -- never dry-run against an endpoint whose guard isn't deployed). It is CLIENT-side (never sends) on `vehicle update`, `ohje update`, `feedback create/resolve`. --idempotency-key dedupes retries (24h). --reason is written to the audit log (required by delete/grant/revoke). --read-only / IB_READ_ONLY blocks every non-GET (exit 3) AND the persisted `company switch` / `auth switch` (they rotate+persist the JWT outside the API client); the ephemeral global `--company <id>` stays allowed (nothing persisted). Read-only refusals carry `code: \"READ_ONLY_BLOCKED\"` (with statusCode 0) in the stderr envelope — distinguishing them from a server-side HTTP 403, which shares exit 3. `feedback create` is exempt (meta request).",
    },
    {
        id: "exit-codes",
        title: "Process exit codes",
        body: "0 ok (incl. --help/--version); 1 generic failure: bare `ib`/bare group help render, `auth login` failure, `doctor` aggregate not-ok, unexpected runtime errors; 2 auth (HTTP 401); 3 permission (403, incl. read-only-mode refusals — envelope code READ_ONLY_BLOCKED); 4 validation (4xx incl. 400/409/429, AND parser usage errors — unknown command/flag, missing required arg/option — emitted as the JSON error envelope with code USAGE); 5 not-found (404); 6 server (5xx); 7 network. Every error path emits the JSON envelope on stderr. Each command's --help ERRORS section lists exit code + HTTP status.",
    },
    {
        id: "multi-tenancy",
        title: "Multi-tenancy & company context",
        body: "Every read/write is scoped to the active company's ownerAsiakasId, derived from your JWT. `ib company switch --to <id>` persists a new active company; the global `--company <id>` runs ONE command in another company's context via an ephemeral (non-persisted) switch (it is named --company because many subcommands have their own --asiakas flag). BetoniJerry is the umbrella tenant asiakasId 1349.",
    },
    {
        id: "changes",
        title: "Audit trail (changeTracker) reading",
        body: "Every tracked write produces field-level rows: who (personId/personName, impersonatedByPersonName when impersonated), when, fieldName old→new, description, and the --reason the writer supplied (X-Action-Reason). Reads: `ib changes entity <type> <id>` for one entity (keikka folds in its keikkaBetoni rows; person/customer/keikka/vehicle/worksite also have `history` shortcuts). Admin-wide views: `changes latest` (newest N), `changes range --from --to` (changes MADE in the window), `changes by-entity-date` (changes affecting deliveries DATED in the window — the grid drawer's view). `changes user [personId]` = changes BY a person. entityType catalog: `ib changes types` (offline). Gates: entity reads need company membership (personAvailability: admin); latest/range/by-entity-date and other-person user reads need an admin role (asiakasAdmin/laskuAdmin/sysadmin). Aggregate views return reason/impersonator only after the 2026-06 backend deploy; nulls before that. NOT in changeTracker: email-send fallback events when the sender had no personId/ownerAsiakasId (stepLog-only edge case).",
    },
    {
        id: "attachments",
        title: "Attachment flow (local vs remote)",
        body: "LOCAL: `attachment upload <file> --<entity> <id>` does mint->PUT->register in one step; `attachment download <id>` saves to disk. REMOTE (/api/cli/exec, MCP): upload/download are DENIED (they would touch the SERVER's filesystem). Instead: `attachment upload-url --name f.ext` -> PUT the bytes yourself (header x-ms-blob-type: BlockBlob) -> `attachment register ...`; for downloads run `attachment get <id>` and fetch blobUrl yourself (expires in 1h). Groups/types are NAMES or ids — legend: `ib attachment types`. delete is irreversible (blob hard-delete) and needs --reason.",
    },
];
/**
 * Render the primer as a fixed-section text block for `ib --help`. Mirrors the
 * parse-friendly style of `formatHelp` (uppercase section headers, two-space
 * indent) so an AI sees a consistent layout across root and per-command help.
 */
export function renderDomainHelp() {
    const lines = [];
    lines.push("");
    lines.push("ABOUT");
    lines.push(`  ${DOMAIN_OVERVIEW}`);
    lines.push("");
    lines.push("GLOSSARY");
    const pad = Math.max(...GLOSSARY.map((g) => g.term.length));
    for (const g of GLOSSARY) {
        lines.push(`  ${g.term.padEnd(pad)}  ${g.definition}`);
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
    lines.push("DISCOVER");
    lines.push("  Commands (cheap, offline): `ib commands` — domain index (~5 KB); `ib commands <domain>`");
    lines.push("    for one group's commands (e.g. `ib commands keikka`); `ib commands --all` for the full");
    lines.push("    flat list; filters --reads / --mutations / --permission <substr>.");
    lines.push("  Full machine-readable specs: `ib reference dump` (entire surface) or `ib reference dump");
    lines.push("    <domain>` for one group. Single command: `ib <command> --help`.");
    lines.push("  Concept guides: `ib help <topic>` — " + TOPICS.map((t) => t.id).join(", ") + ".");
    return lines.join("\n");
}
//# sourceMappingURL=domain.js.map