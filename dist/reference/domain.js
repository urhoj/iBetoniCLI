/**
 * Domain primer for betoni.online — the *what*, not the *how*.
 *
 * `specs.ts` teaches an AI how to call each command; this file teaches it what
 * it is operating on (the business, the multi-tenant model, the Finnish entity
 * vocabulary). Both ride along in the single artifact an AI ingests at session
 * start: `ib reference dump` embeds {@link DOMAIN_OVERVIEW} and a DB-fetched
 * glossary as top-level keys; `ib --help` renders the overview plus a pointer
 * to `ib glossary` via {@link renderDomainHelp} (the full term index is fetched
 * on demand, not dumped into every help render). One source of truth → the
 * primer can never drift from the CLI it describes.
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
/**
 * Offline one-line blurbs per command DOMAIN, for `ib commands` (domain index)
 * and computed group help. This is CLI-structure documentation (available
 * without a backend) — distinct from the DB-backed vocabulary glossary
 * (`ib glossary`), which owns synonyms/definitions and is fetched at runtime.
 */
export const DOMAIN_BLURBS = {
    keikka: "Concrete delivery/pumping orders — the central entity.",
    betoni: "Concrete reference data: grades (betoniLaatu), additives (betoniAttr), and the fixed lookup lists. Read-only. `asiakasId 0` = the SHARED (yhteinen) rows every tenant sees; each row carries a derived `shared` boolean.",
    customer: "Customer companies you deliver to.",
    worksite: "Construction sites where concrete is delivered.",
    sijainti: "Geocoded locations — depots, plants, destinations.",
    vehicle: "Pump and mixer trucks — incl. `vehicle driver` (day-driver dispatch + standing default driver).",
    person: "System users — drivers, admins, office staff (incl. `person absences`).",
    company: "The tenant company your token acts as (multi-tenancy) — a LENS (list/current/switch), not the record. The `asiakas` RECORD and its flags live under `ib customer`: `get <id>`, `modules`, `settings` — target your own asiakasId (`ib company current`).",
    fennoa: "Fennoa accounting integration — PumiNet Oy purchase invoices (system admin).",
    schedule: "Date-scoped views of keikkas: today / a day / a week.",
    stats: "Aggregated delivery statistics — `stats --all` is the only CROSS-TENANT (developer) rollup; use it instead of looping `keikka list --company` over companies.",
    opendata: "Free/open external-data APIs — building registries, FMI weather, PRH business registry.",
    jerry: "BetoniJerry RFQ marketplace: requests, offers, confirmation.",
    message: "Chat threads, the announcement board, and daily grid notes.",
    attachment: "Files (photos/PDFs) linked to entities via Azure Blob.",
    legal: "Versioned legal documents and per-person acceptances.",
    validate: "Company and person readiness validation profiles.",
    log: "Field-level audit trail (changeTracker).",
    task: "Recurring operator tasks — weekly/monthly work for humans + AI (due-since + done-log).",
    sales: "betoni.online SaaS sales pipeline (system admin) — prospects + the companies actually running keikkaa.",
    dev: "Developer & maintainer tools — CLI feedback, changelog, perf, cache, schema, AI logs, operator inbox.",
    glossary: "Domain glossary — resolve a term/synonym to its meaning + commands.",
    ohje: "UI help-text content behind HelperIcon.",
    reference: "Machine-readable CLI catalogue (dump / detail).",
    auth: "Login, logout, token, company switch.",
    doctor: "Aggregated CLI/connectivity health report.",
};
export const domainBlurb = (domain) => DOMAIN_BLURBS[domain] ?? null;
/**
 * Guidance for an AI consuming this CLI on WHEN to file feedback. Surfaced in
 * `ib --help` and embedded in `ib reference dump` so it rides along with the
 * primer the AI ingests at session start. Intent: proactive, immediate feedback
 * (no need to ask the user) that makes the CLI better over time — the channel is
 * `ib dev feedback create`, which is silent, low-cost, and works under --read-only.
 */
export const FEEDBACK_GUIDANCE = {
    summary: "If you are an AI using this CLI, file feedback with `ib dev feedback create` " +
        "PROACTIVELY and IMMEDIATELY — you do NOT need to ask the user first. It is " +
        "low-cost, safe, and works even under --read-only — no GitHub issue and no " +
        "spam back to you or the user (only opted-in developers get a quiet push). " +
        "This is the primary way the CLI improves, so err on the side of filing.",
    fileWhenYou: [
        "hit ANY error or an unexpected exit code",
        "had to try several strategies because the help/docs were unclear, missing, or wrong",
        "found a command, flag, or its output confusing or harder to use than expected",
        "could not find a command for something the user asked for that this CLI probably should do (a capability gap)",
        "noticed an inconsistency between commands (naming, behaviour, flags, or output shape)",
        "have suggestions for improving the CLI's usability or user experience",
        "too high token consumption or too many API calls for a given task (cost/efficiency)",
    ],
    how: "Use --kind bug for breakage, --kind improvement for gaps/ideas. Attach " +
        "--command (what you ran) and --error (the message) so it can be reproduced.",
};
/** Concept guides for cross-cutting knowledge, surfaced by `ib help <id>` and embedded in `ib reference dump`. */
export const TOPICS = [
    {
        id: "roles",
        title: "Role model (two layers)",
        body: "`customer person list` row `roleTypeId` only echoes the --role FILTER (null = base membership), NOT the person's role set. For the full per-company roles use `ib person role list <personId> --asiakas <id>`. One `person role grant` adds exactly ONE setting (no bundle). Resolve role NAME<->typeId and see access tiers with `ib person role explain <name>`.",
    },
    {
        id: "jerry-lifecycle",
        // The PII-masking sentence below (masked on the provider inbox and the fan-out
        // email, NOT on `request get --provider`) is also stated in the `ib jerry request
        // get` spec description in reference/specs.ts — keep both in sync. Commit c37700d
        // corrected two copies of this claim and missed THIS one, leaving the catalogue
        // self-contradictory until a494ac5 (fb#551).
        title: "BetoniJerry RFQ lifecycle",
        body: "Request: draft -> open (provider inbox). Offer: draft -> pending (provider `offer send`) -> accepted (CUSTOMER `offer accept`, siblings rejected) -> confirmed (PROVIDER `offer confirm`, which BUILDS a keikka). Customer PII is masked on the provider inbox (`request list --open`) and in the fan-out email, but NOT on `request get --provider`: every matched provider sees the full lead (name, address, lat/lng, phone, email) as soon as the request is open. Use `ib jerry check-address` to debug 'no offers'.",
    },
    {
        id: "write-safety",
        title: "Write safety: dry-run, idempotency, reason, read-only",
        body: "--dry-run is SERVER-side on most writes (sends X-Dry-Run; if the handler doesn't honour it the write PERSISTS -- never dry-run against an endpoint whose guard isn't deployed). It is CLIENT-side (never sends) on `vehicle update`, `ohje update`, `feedback create/resolve`. --idempotency-key dedupes retries (24h). --reason is written to the audit log (required by delete/grant/revoke). --read-only / IB_READ_ONLY blocks every non-GET (exit 3) AND the persisted `company switch` / `auth switch` (they rotate+persist the JWT outside the API client); the ephemeral global `--company <id>` stays allowed (nothing persisted). Read-only refusals carry `code: \"READ_ONLY_BLOCKED\"` (with statusCode 0) in the stderr envelope — distinguishing them from a server-side HTTP 403, which shares exit 3. `feedback create` is exempt (meta request).",
    },
    {
        id: "exit-codes",
        title: "Process exit codes",
        body: "0 ok (incl. --help/--version); 1 generic failure: bare `ib`/bare group help render, `auth login` failure, `doctor` aggregate not-ok, unexpected runtime errors; 2 auth (HTTP 401); 3 permission (403, incl. read-only-mode refusals — envelope code READ_ONLY_BLOCKED); 4 validation (4xx incl. 400/409/429, AND usage errors — unknown command/flag, missing required arg/option, whether Commander rejects them at parse time or a handler enforces the same rule itself (e.g. `ib legal show` with no type) — emitted as the JSON error envelope with code USAGE; other client-side guards, where the command rejects a value it did parse, exit 4 with code null); 5 not-found (404); 6 server (5xx); 7 network. Every error path emits the JSON envelope on stderr. Each command's --help ERRORS section lists exit code + HTTP status.",
    },
    {
        id: "multi-tenancy",
        title: "Multi-tenancy & company context",
        body: "Every read/write is scoped to the active company's ownerAsiakasId, derived from your JWT. `ib company switch --to <id>` persists a new active company; the global `--company <id>` runs ONE command in another company's context via an ephemeral (non-persisted) switch (it is named --company because many subcommands have their own --asiakas flag). BetoniJerry is the umbrella tenant asiakasId 1349.",
    },
    {
        id: "log",
        title: "Audit trail (changeTracker) reading",
        body: "Every tracked write produces field-level rows: who (personId/personName, impersonatedByPersonName when impersonated), when, fieldName old→new, description, and the --reason the writer supplied (X-Action-Reason). Reads: `ib log entity <type> <id>` for one entity (keikka folds in its keikkaBetoni rows; person/customer/keikka/vehicle/worksite also have `log` shortcuts). Admin-wide views: `log latest` (newest N), `log range --from --to` (changes MADE in the window), `log by-entity-date` (changes affecting deliveries DATED in the window — the grid drawer's view). `log user [personId]` = changes BY a person. entityType catalog: `ib log types` (offline). Gates: entity reads need company membership (personAvailability: admin); latest/range/by-entity-date and other-person user reads need an admin role (asiakasAdmin/laskuAdmin/sysadmin). Aggregate views return reason/impersonator only after the 2026-06 backend deploy; nulls before that. NOT in changeTracker: email-send fallback events when the sender had no personId/ownerAsiakasId (stepLog-only edge case).",
    },
    {
        id: "attachments",
        title: "Attachment flow (local vs remote)",
        body: "LOCAL: `attachment upload <file> --<entity> <id>` does mint->PUT->register in one step; `attachment download <id>` saves to disk. REMOTE (/api/cli/exec, MCP): upload/download are DENIED (they would touch the SERVER's filesystem). Instead: `attachment upload-url --name f.ext` -> PUT the bytes yourself (header x-ms-blob-type: BlockBlob) -> `attachment register ...`; for downloads run `attachment get <id>` and fetch blobUrl yourself (expires in 1h). Groups/types are NAMES or ids — legend: `ib attachment types`. delete is irreversible (blob hard-delete) and needs --reason.",
    },
    {
        id: "shell-quoting",
        title: "Windows shell quoting: prose via --from-json, clear a field with --flag=",
        body: 'Windows PowerShell mangles native-exe arguments in THREE ways, and Git Bash adds a FOURTH of its own (item 4 — it defeats the --from-json escape hatch the first three are fixed with, so read it before trusting a pipe). Two of them corrupt long-form PROSE (feedback reports, changelog entries, resolution notes); the third eats an EMPTY-STRING argument, which is how you CLEAR a field. Only one of the three is reliably loud.\n\n1. DOUBLE QUOTES — LOUD. PowerShell splits a native argument on its INNER double-quotes, and prose is exactly the text most likely to contain them (quoted identifiers, JSON fragments, error strings). The CLI then sees several positionals and exits 4 with "too many arguments" — or, when no split fragment starts with `-`, silently stores text TRUNCATED at the first quote (destructive on update/resolve commands, which overwrite the stored row). (fb#299/#300/#327/#332)\n\n2. BACKTICKS — SILENT. The backtick is PowerShell\'s ESCAPE character, so inside a double-quoted argument it is consumed and its sequence EXPANDED before the CLI ever sees it: `r becomes a carriage return, `n a newline, `t a tab. A markdown `resolve` is therefore stored as CR + "esolve" — exit code 0, no warning, and the corrupted text is now the permanent record. This is the more dangerous half precisely because nothing fails, and backticks are how anyone writes an identifier, a flag name or a code fragment in prose. Note the damage is an injected CONTROL CHARACTER, not a literal backslash. (fb#552)\n\nFIX FOR 1 AND 2: pass the whole payload via --from-json <file|-> (sidesteps argv entirely; required flags may come from the JSON). PER-COMMAND, not universal: every command carrying a --body payload has it, and so do the prose writers (changelog/feedback/message/notification/person notify/glossary/task/sales/worksite/customer/keikka/sijainti/ohje), but a command with only typed flags and no payload may not — check `ib <cmd> --help`, which lists it when present. Where it is absent the equals form and short values are the fallback. Stripping the quotes or backticks instead silently degrades the permanent record. The CLI warns on stderr when it detects the signature of an eaten backtick, but detection is best-effort — --from-json is the guarantee. With one qualification: a FILE is byte-exact, while `-` is only as faithful as the pipe feeding it (item 4).\n\n3. EMPTY STRING — LOUD OR SILENT, depending on what follows it. PS 5.1 DROPS an empty-string argument entirely when calling a native exe ([string]::Empty and $null go the same way), and the flag then STEALS the next token as its value. Three outcomes, and only the first two announce themselves: (a) the next token is a ROOT global such as --pretty — Commander will not consume a known option as an option-argument and exits 4 with "argument missing"; (b) a positional is left stranded — `--email "" --asiakas 1380` becomes `--email --asiakas` plus a stray 1380 and exits 4 with "too many arguments", the shape fb#634 was filed from; (c) the next token is a LOCAL flag or a bare word — it is consumed as the value and NOTHING fails. `--reason "" --dry-run` yields reason = the literal string "--dry-run" with the dry-run silently swallowed, so a rehearsal becomes a REAL write whose audit trail records a flag name; `--email "" --dry-run` persists "--dry-run" into the field you meant to clear. (fb#634)\n\nFIX FOR 3: use the EQUALS form — `--email=`, nothing after the sign. PowerShell passes it through intact and it means exactly the same thing in bash, so it is the one clear-a-field syntax that works in every shell; prefer it over `--email ""` everywhere, including in bash. Where the convention applies: --comment/--memo/--email and siblings on worksite/person/customer update, --synonyms/--related/--entity on glossary set, --email on jerry provider-settings set, --parked-until on jerry prospect, --title on message thread, --summary/--detail on reference detail set, --instructions/--skill/--agent on task update, --img on ohje update, and --with on the textEdit trio (where empty deletes the matched text). NOT `sijainti update`, which clears via an explicit JSON null in --body rather than an empty typed flag. The CLI now REFUSES any flag whose value is another flag name that arrived as the next separate token, so the silent shape above exits 4 instead of writing. If you genuinely mean a value that looks like a flag, the equals form passes it through: `--command=--dry-run`.\n\n4. GIT BASH BACKSLASH COLLAPSE (a HEREDOC into `--from-json -`) — SILENT until the JSON fails to parse. Items 1-3 are PowerShell; this one bites the shell you reach for to ESCAPE PowerShell. Piping a quoted heredoc into `-` on Windows Git Bash delivers BOTH an escaped `\\\\` and a lone `\\` to the process as ONE backslash, so an escaped backslash cannot be expressed that way at all: the JSON arrives with a bare `\\H`, JSON.parse calls it a bad escape, and the payload you authored was valid. Measured 2026-08-17, both spellings, same single byte. The same bytes written to a FILE survive intact and parse. So: any payload containing a backslash (Windows paths, regexes, `\\n` inside a string) goes in a FILE — `--from-json ./entry.json`, never `--from-json -` off a heredoc. A pipe is fine for backslash-free prose, which is most of it. (fb#705)',
    },
    {
        id: "severity",
        title: "Feedback severity (urgency/impact: critical|major|minor|cosmetic)",
        body: "`feedback create/update --severity <critical|major|minor|cosmetic>` is the urgency+impact grade, ORTHOGONAL to --complexity (severity = how much it matters; complexity = effort + can an agent act unattended).\n\nGRADE THE WORST PLAUSIBLE CONSEQUENCE OF LEAVING IT UNFIXED — not how annoying it was to hit, and NEVER relative to what else is in the queue today. Absolute grading is what makes two triage runs comparable; grading against the current backlog silently re-ranks every row each time the queue changes shape, so yesterday's `major` stops meaning today's `major` and the sort order you wanted to trust becomes noise.\n\nLadder: critical = production is broken or unsafe RIGHT NOW — users blocked, data loss or corruption, cross-tenant leak, auth bypass, money/invoices wrong; jump the queue. major = a real capability is broken or unusable for its purpose, but a workaround exists or it is not live-facing — wrong results, a command that cannot do its stated job, a misleading doc that sends every agent down a dead end. minor = it works, but is wrong or awkward in a BOUNDED way — confusing or missing help, a missing flag, an inconsistency between sibling commands, a one-off papercut. cosmetic = output formatting, wording, tidiness; no behaviour is wrong.\n\nNOT the vocabulary most issue trackers use. Five synonyms are RECOGNISED and named back to you in the exit-4 `did you mean`, but never accepted as aliases — an unknown enum value is always reported, never quietly rewritten (fb#369, re-confirmed fb#1115): map high→major, medium→minor, low→cosmetic, blocker→critical, trivial→cosmetic.\n\nPairing: severity picks WHAT to do next, complexity picks WHETHER an agent can take it unattended (`feedback list --max-complexity 3 --unresolved`). The two do not correlate — a one-character typo in a prod SQL filter is critical+1; a nice-to-have new subcommand is cosmetic+4.\n\nFiling agents should set it on EVERY row, not just `--kind bug`. An unset severity is indistinguishable from 'nobody has judged this yet', and `feedback list` cannot usefully sort on a field that is null across most of the table — which is exactly the state the queue drifted into before this topic existed (fb#618).",
    },
    {
        id: "complexity",
        title: "Feedback complexity (AI-agent triage 1-5)",
        body: "`feedback create/update --complexity <1-5>` is a self-estimated difficulty+autonomy grade, ORTHOGONAL to --severity (severity = urgency/impact; complexity = effort + can an agent act unattended). Ladder: 1 = simple, an agent fixes it autonomously with no questions; 2 = simple, benefits from user input but proceeds on a recommended approach; 3 = complex but still autonomous; 4 = complex, needs user feedback; 5 = very complex, needs user feedback AND a heavier model (opus/fable). Workflow: a batch-fix agent pulls `feedback list --max-complexity 3 --unresolved` (ascending is the natural order — bank cheap wins first) and works them in sequence; if investigation reveals more than the initial estimate, PROMOTE with `feedback update <id> --complexity 4` so it drops out of the autonomous slice into the human-gated bucket. The filing agent sets the initial estimate; treat `<=3` as \"attempt, then bail/promote if reality disagrees\", not a guarantee.",
    },
];
/**
 * Render the primer as a fixed-section text block for `ib --help`. Mirrors the
 * parse-friendly style of `formatHelp` (uppercase section headers, two-space
 * indent) so an AI sees a consistent layout across root and per-command help.
 * The GLOSSARY section is a fixed pointer to `ib glossary` — the full
 * term/synonym index is fetched on demand (`ib glossary list --terms-only`),
 * NOT dumped into every help render, so help stays small (and needs no network
 * round-trip) as the self-improving glossary grows.
 *
 * Tier-blind on purpose: the only tier-sensitive content this block ever had
 * was the glossary, which is now a pointer resolved server-side per caller.
 */
export function renderDomainHelp() {
    const lines = [];
    lines.push("");
    lines.push("ABOUT");
    lines.push(`  ${DOMAIN_OVERVIEW}`);
    lines.push("");
    lines.push("GLOSSARY (Finnish & domain vocabulary — looked up on demand, not listed here)");
    lines.push("  Term + synonym index:  `ib glossary list --terms-only`");
    lines.push("  Define a single term:  `ib glossary lookup <term>`");
    lines.push("");
    lines.push("FILING FEEDBACK (AI users — be proactive)");
    lines.push(`  ${FEEDBACK_GUIDANCE.summary}`);
    lines.push("  File `ib dev feedback create` whenever you:");
    for (const t of FEEDBACK_GUIDANCE.fileWhenYou) {
        lines.push(`    - ${t}`);
    }
    lines.push(`  ${FEEDBACK_GUIDANCE.how}`);
    lines.push("");
    lines.push("OUTPUT");
    lines.push("  All commands: JSON on stdout; errors as a JSON envelope on stderr. Exit codes: 0 ok ·");
    lines.push("    1 generic · 2 auth · 3 permission · 4 validation · 5 not-found · 6 server · 7 network");
    lines.push("    — details: `ib help exit-codes`.");
    lines.push("");
    lines.push("DISCOVER");
    lines.push("  First run: `ib auth login` (opens browser) or set IB_TOKEN=<jwt>; verify with `ib doctor`.");
    lines.push("  Commands (cheap, offline): `ib commands` — domain index (~5 KB); `ib commands <domain>`");
    lines.push("    for one group's commands (e.g. `ib commands keikka`); `ib commands --all` for the full");
    lines.push("    flat list; filters --reads / --mutations / --permission <substr>.");
    lines.push("  Full machine-readable specs: `ib reference dump` (entire surface) or `ib reference dump");
    lines.push("    <domain>` for one group. Single command: `ib <command> --help`.");
    lines.push("  Concept guides: `ib help <topic>` — " + TOPICS.map((t) => t.id).join(", ") + ".");
    return lines.join("\n");
}
//# sourceMappingURL=domain.js.map