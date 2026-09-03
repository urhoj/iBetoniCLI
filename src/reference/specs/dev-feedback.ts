// dev-feedback specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { KINDS as FEEDBACK_KINDS, SCOPES as FEEDBACK_SCOPES, STATUSES as FEEDBACK_STATUSES, SEVERITIES as FEEDBACK_SEVERITIES, SEVERITY_FILTERS as FEEDBACK_SEVERITY_FILTERS, GATE_KINDS as FEEDBACK_GATE_KINDS, GATED_FILTERS as FEEDBACK_GATED_FILTERS, AUTO_CLOSE_GATE_KINDS as FEEDBACK_AUTO_CLOSE_GATE_KINDS, RELATION_TYPES as FEEDBACK_RELATION_TYPES } from "../../commands/feedback/index.js";
import { apiErr, clearHint, COMMON_AUTH_ERRORS, intParseErr, limitErr } from "./shared.js";

export const DEV_FEEDBACK_SPECS: CommandSpec[] = [
  // ─── feedback (5) ────────────────────────────────────────────────────────
  // NOTE on classification: feedback create/resolve carry custom write semantics
  // (meta-exempt create, client-side --dry-run, no idempotency/reason), so they
  // keep writeFlags:false — the standard write-safety block would mis-document
  // them. mutates:true is set explicitly so `ib commands --mutations` picks them
  // up and `--reads` excludes them despite writeFlags:false.
  {
    command: "ib dev feedback import",
    description:
      "File SEVERAL reports from one JSON array file. Same per-entry keys as `create` (description|body|title, kind?, scope?, command?, error?, severity?, complexity?, gateKind?, gateRef?, gateUntil?), defaults included. Exists because filing N findings is the routines' normal shape — post-impl-verify files one row per confirmed finding, and analyze-cli-feedback / groom-memory / review-legal-docs fan out the same way — so the alternative is N invocations or a caller-side splitting step (fb#1056). A SINGLE entry still goes to `create --from-json`, which takes an object.",
    auth: "any",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "file", type: "string", required: true, description: "JSON array file of create objects (or - for stdin)" }],
    flags: [{ name: "dry-run", type: "boolean", description: "Resolve client-side: print what each entry would send, never send" }],
    outputShape: "{ results: [{index, feedbackId, ok, error?}], ok, failed }",
    errors: [
      { origin: "client", exit: 4, match: "not valid JSON", meaning: "The file could not be parsed at all", remedy: "Check the file is UTF-8 JSON; no entry has been read yet, so the key names are not the problem" },
      { origin: "client", exit: 4, match: "root must be an array", meaning: "The JSON root is an object, not an array", remedy: "A single entry goes to `ib dev feedback create --from-json`, which takes an object; wrap it in [ ] only if you really mean a batch" },
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "A per-entry failure does NOT exit non-zero — the call succeeds and reports it. Check `failed`, not just the exit code; each result carries its array `index`, the failed ones their `error`.",
      "Partial failure is REPORTED, never rolled back — re-send only the failed entries. A non-object entry counts as failed rather than aborting the batch.",
      "Filed with bounded concurrency (5); write ordering is not guaranteed — read `feedbackId` per result.",
      "Entries get the `create --from-json` key contract (fb#1085): an unknown or wrong-typed key fails THAT entry, never a silent drop — strip the read-only keys (feedbackId, status, …) off a templated `feedback get` row. Gate fields (gateKind/gateRef/gateUntil) are carried, so batch-filed rows can be gated like created ones.",
    ],
    examples: ["ib dev feedback import ./findings.json", "ib dev feedback import - --dry-run"],
  },
  {
    command: "ib dev feedback create",
    aliases: ["ib dev feedback add"],
    description:
      "File a CLI improvement proposal or trouble report. AI users: file this PROACTIVELY and IMMEDIATELY (no need to ask the user) whenever you hit an error or unexpected exit code, had to try several strategies because the help/docs were unclear/missing/wrong, found something confusing or harder than expected, could not find a command for something the user clearly needs (a capability gap), or saw an inconsistency between commands. Stored quietly server-side (no GitHub issue, no spam to you or the user — distinct from bug reports; developers who opted in get a push notification) for later developer triage. Sent as a META request, so it is EXEMPT from the read-only write-lock: you can file feedback even with --read-only / IB_READ_ONLY active. --dry-run resolves client-side (prints the payload, never sends).",
    auth: "any",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "description", type: "string", description: "freetext description of the friction, gap, or bug" }],
    flags: [
      { name: "description", type: "string", description: "Alias for the positional description; if both are passed, they must match" },
      { name: "body", type: "string", description: "Alias for --description (free text — NOT the raw-JSON --body of the entity update commands); if several are passed, they must match" },
      { name: "title", type: "string", description: "Optional title, folded into the description as its first line (feedback rows have no stored title column). Alone it becomes the whole description." },
      { name: "kind", type: "string", default: "improvement", description: "improvement (CLI UX friction) | bug (CLI defect) | idea (new-capability proposal) | legal (legal-document change/draft proposal). STRICT: an unknown value exits 4 (it used to fall back to improvement, which mis-triaged bug reports silently — feedback #369)", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", default: "cli", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — which product surface this targets (routing key for triage; orthogonal to --kind; impeccable = auto-piped design-hook findings)", allowed: [...FEEDBACK_SCOPES] },
      { name: "command", type: "string", description: "The ib command/argv that triggered the friction" },
      { name: "error", type: "string", description: "Error message you hit, if any" },
      { name: "severity", type: "string", description: "critical | major | minor | cosmetic — optional triage weight, most useful with --kind bug. NOT the issue-tracker vocabulary most tooling uses. Five synonyms are RECOGNISED but never accepted — an unknown value always exits 4 with a `did you mean` naming the right one, and is never silently rewritten (fb#369): high→major, medium→minor, low→cosmetic, blocker→critical, trivial→cosmetic. Pass the mapped value, not the synonym", allowed: [...FEEDBACK_SEVERITIES] },
      { name: "complexity", type: "number", description: "1-5 agent-triage estimate (orthogonal to --severity): 1 simple+autonomous · 2 simple+wants-input · 3 complex+autonomous · 4 complex+needs-user · 5 very-complex+needs-user & heavier model. Lets a batch-fix agent pull `list --max-complexity 3`. See `ib help complexity`." },
      { name: "gate-kind", type: "string", description: "What this row is waiting for, if it is a GATED row rather than a plain proposal: deploy (a repo@version ships) | soak (a wake date elapses) | legal (a document version is superseded) | owner-decision (a call only the owner can make) | owner-action (something only the owner can do) | backlog. Bare `owner` is LEGACY and still accepted, but prefer the split — it is what makes the blocked queue filterable, and the distinction used to live in free-text --gate-ref where nothing could read it. Most rows have no gate at all — omit it.", allowed: [...FEEDBACK_GATE_KINDS] },
      { name: "gate-ref", type: "string", description: "Gate pointer, meaning depends on --gate-kind: deploy → repo@sha being waited on; legal → TYPE@version (the version being superseded); owner-decision/owner-action → free text naming the call or the task. Only meaningful together with --gate-kind." },
      { name: "gate-until", type: "string", description: "Wake date (YYYY-MM-DD, an ISO datetime, or today/yesterday/tomorrow) for --gate-kind soak|backlog. Validated CLIENT-SIDE (fb#446) — the backend does not validate it, so a malformed date used to reach SQL as a 500 instead of a clean 400." },
      { name: "from-json", type: "string", description: "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Keys: description (or body), title, kind, scope, command, error, severity, complexity, gateKind, gateRef, gateUntil. The READ shape's `errorText` is also accepted for `error`, so a stored feedback row can template the file. An unknown or wrong-typed key exits 4 (never silently dropped)." },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape:
      "{ feedbackId } on success (HTTP 201). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, match: ["is required", "must be one of", "must be an integer"], meaning: "Validation", remedy: "description is required; all enums are STRICT — an unknown value exits 4 and is never rewritten: --kind must be improvement|bug|idea|legal, --scope must be cli|app|jerry|bsg2|workspace|security|ops|impeccable|other, --severity (when given) must be critical|major|minor|cosmetic (NOT the issue-tracker vocabulary — high≈major, medium≈minor, low≈cosmetic, blocker≈critical, trivial≈cosmetic; all five are hinted, none is accepted), --gate-kind (when given) must be deploy|soak|legal|owner-decision|owner-action|backlog (bare owner is accepted as legacy); --complexity, when given, must be an integer 1-5. The message names the closest valid value when there is one" },
      { origin: "client", exit: 4, match: "must be YYYY-MM-DD or an ISO datetime", meaning: "--gate-until is not a parseable date — validated CLIENT-SIDE (fb#446), before the backend (which does not validate it at all)", remedy: "pass YYYY-MM-DD, a full ISO datetime, or today/yesterday/tomorrow" },
      { origin: "client", exit: 4, match: "too many arguments", meaning: "too many arguments — the shell split the description, on its inner double-quotes OR on its newlines (typical on Windows PowerShell)", remedy: "Pass the report via --from-json <file|-> instead of argv" },
      { origin: "client", exit: 4, match: "unknown option", meaning: "unknown option — when the rejected token is not a flag name anybody would type (`->`, `--`-prefixed punctuation), it is a FRAGMENT of your description that the shell split off as its own argument, not a bad flag (fb#702)", remedy: "Check the rejected token before re-reading the flag list: if it is a piece of your prose, your flags are fine and the shell is the problem — pass the report via --from-json <file|->. A genuinely mistyped flag gets a did-you-mean instead" },
      { origin: "client", exit: 4, match: "--from-json", meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key", remedy: "The error says WHICH of the four: an unopenable path, a JSON syntax error (no field has been read yet, so the key names are not the problem), a root that is not an object, or an unknown / wrong-typed key. Only the last two are about field names" },
      apiErr(
        400,
        "Backend predates the owner gate split",
        "this backend's gateKind vocabulary has no owner-decision/owner-action (they ship in puminet5api@1.33.1, production since 2026-09-03) — against it use bare --gate-kind owner, the legacy value it still accepts (fb#1224)",
        "gatekind must be one of"
      ),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "You can pass the description positionally or as its --description/--body aliases; if you pass more than one, they must match. Here --body is FREE TEXT, unlike the raw-JSON --body on the entity update commands.",
      "gh-issue-style invocation works: `feedback add --title X --description Y` — `add` aliases `create`, and --title is prepended to the description as its first line (blank line between). Feedback rows store only a description, so the title is a formatting convenience, not a separate field.",
      'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev feedback create --kind bug -- "--pretty output too wide". Everything after `--` is taken as positional text.',
      "SHELL QUOTING (fb#299, fb#702): a report body (and --command/--error) is exactly the text most likely to carry inner double-quotes, which Windows PowerShell splits on — and NEWLINES split the same way, so a multi-line here-string with no quotes at all fails too. The tell differs by where the fragment lands: a bare word reads as `too many arguments`, a dash-led one (`->` out of \"200 -> null\") reads as `unknown option`, which looks like a flag mistake and is not. Pass long, multi-line or quote-bearing reports via --from-json <file|->; see `ib help shell-quoting`.",
      "When invoked by the betoni.online /ai assistant, the originating conversation id is auto-attached as context.conversationId (via the IB_CONVERSATION_ID env var the /ai loop injects) — a developer can then read the full conversation with `ib dev ai conversation <id>`. Manual CLI use does not set it.",
      "No --reason / --idempotency-key (unlike `ib dev changelog add`): a META request, not an audited entity mutation.",
    ],
    examples: [
      'ib dev feedback create "schema table output should include row counts"',
      'ib dev feedback create --description "schema table output should include row counts"',
      'ib dev feedback create --body "gh-style --body works as a --description alias"',
      'ib dev feedback add --title "Row counts missing" --description "schema table output should include row counts"',
      'ib dev feedback create "keikka list --pvm rejected my date" --kind bug --command "keikka list --pvm 1.6." --error "invalid date format"',
      'ib dev feedback create "ib customer search --email" --kind idea --dry-run',
      'ib dev feedback create "TOS 2.0 lacks a clause covering the AI assistant features; draft update suggested" --kind legal',
      'ib dev feedback create "Jerry inbox should show boom length on request cards" --scope jerry --kind idea',
      'ib dev feedback create "keikka editor throws on save" --kind bug --severity major',
      "ib dev feedback create --from-json ./report.json",
      "ib dev feedback create --from-json ./report.json --kind bug",
      'ib dev feedback create "add row counts to schema table output" --kind idea --complexity 2',
      'ib dev feedback create "wait for the fb#941 detail-cap raise to ship" --gate-kind deploy --gate-ref "puminet5api@a930ccaf"',
    ],
  },
  {
    command: "ib dev feedback list",
    description:
      "List filed feedback for triage. Developer-only (isSystemAdmin / isDeveloper). Newest first, paginated (default 50, cap 200). By DEFAULT returns only active items (status open + reviewed) — closed items (applied/dismissed) are hidden; pass --all for every status, or --status to name specific ones.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "status", type: "string", description: "open | reviewed | applied | dismissed, or a comma-separated list (e.g. open,reviewed)", allowed: [...FEEDBACK_STATUSES] },
      { name: "unresolved", type: "boolean", description: "Shortcut for --status open,reviewed (un-closed items) — same as the default; mutually exclusive with --status/--all" },
      { name: "all", type: "boolean", description: "Include every status (open,reviewed,applied,dismissed); overrides the open+reviewed default; mutually exclusive with --status/--unresolved" },
      { name: "kind", type: "string", description: "improvement | bug | idea | legal", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other", allowed: [...FEEDBACK_SCOPES] },
      { name: "search", type: "string", description: "Substring match over description/command/resolution/errorText (deploy-gated)" },
      { name: "complexity", type: "string", description: "Only items with this exact complexity 1-5, or `none` for the rows with NO estimate at all (deploy-gated). ⚠ A NUMERIC value EXCLUDES unestimated rows, which is most of the table — absent means unestimated, not complex; `--complexity none` is how you select exactly that set for a backfill pass (fb#535)." },
      { name: "max-complexity", type: "number", description: "Only items with complexity <= n — the autonomously-workable slice a batch-fix agent pulls (deploy-gated). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex; use `--complexity none` to find those." },
      { name: "severity", type: "string", description: "Only items with this exact severity, or `none` for the rows with NO grade at all — the severity twin of `--complexity none` (deploy-gated). Before this existed severity was ORDERABLE but not selectable, so 'which rows still need a grade?' cost a full unresolved page filtered client-side, against a 200-row cap. Unlike --complexity, an unknown value is REJECTED (exit 4), never answered with the whole table.", allowed: [...FEEDBACK_SEVERITY_FILTERS] },
      { name: "oldest", type: "boolean", description: "Oldest-first (createdAt ASC) — FIFO drain order so the triage loop clears the backlog before newer arrivals; default is newest-first" },
      { name: "limit", type: "number", default: "50", description: "Max rows, HARD-CAPPED at 200 by the backend. Asking for more is not an error and not honoured — you get 200 rows and a stderr warning; `truncated: true` says the page was capped (fb#605). Page the rest with --offset." },
      { name: "offset", type: "number", default: "0", description: "Skip N rows — how you reach anything beyond the 200-row cap. `--limit 200`, then `--limit 200 --offset 200`, and so on." },
      { name: "full", type: "boolean", description: "Return untruncated description/resolution (default: each capped at 200 chars)" },
      { name: "unclaimed", type: "boolean", description: "Only items no agent currently holds — the set you should pick from. Includes rows whose claim EXPIRED (the 24h reclamation), not just never-claimed ones. Mutually exclusive with --mine/--claimed-by/--held." },
      { name: "mine", type: "boolean", description: "Only items YOU currently hold (shorthand for --claimed-by <your resolved label>)" },
      { name: "claimed-by", type: "string", description: "Only items held by this label, and only while the claim is still LIVE" },
      { name: "held", type: "boolean", description: "Only items ANY agent currently holds (live leases, any holder) — the 'what is being worked on right now' triage view, the complement of --unclaimed without knowing every claimant label. An expired lease counts as free, not held. Mutually exclusive with --unclaimed/--mine/--claimed-by; deploy-gated and CHECKED like --severity (see notes)." },
      { name: "gated", type: "string", description: "Only rows carrying a gate (gateKind IS NOT NULL); pass a value to restrict to one kind (e.g. --gated owner-action), or `owner-any` for the whole human-blocked family (owner + owner-decision + owner-action). Use owner-any whenever you mean 'waiting on a person': bare `owner` is the LEGACY value only, so naming it answers 0 on a queue whose rows have been reclassified, which reads as 'nothing is blocked'. Filtered SERVER-SIDE since fb#1198 — it previously filtered client-side over one 200-row page, so `--gated --all` answered 1 when the table held 18, and because the page is newest-first the rows it dropped were the OLDEST, i.e. the longest-blocked. Deploy-gated but CHECKED like --severity: an older backend ignores the param and answers unfiltered, which under a gate lens reads as 'every row is blocked', so a mismatch raises a loud stderr warning plus an envelope hint.", allowed: [...FEEDBACK_GATED_FILTERS] },
      { name: "ungated", type: "boolean", description: "Only rows carrying NO gate (gateKind IS NULL) — the complement of bare --gated, and the 'workable right now' half of a fix-session slice (pair it with --unclaimed --max-complexity N). Filtered CLIENT-SIDE — the backend's gated param has no negation value — and therefore routed over the complete per-status walk, so no row is dropped to the 200-row cap: a lone --status walks that status, --all fans out over all four. Mutually exclusive with --gated (exit 4) (fb#1209)." },
    ],
    outputShape:
      "{ items: FeedbackRow[] (description/resolution/errorText capped at 200 chars unless --full), nextCursor: null, count, truncated?, hint? }. Each row carries `changelogLinks: [{changelogId, role}]` — the same shape `get` returns — so a PARTLY-shipped row is visible before you claim it (fb#647). Every row ALSO carries gateKind/gateRef/gateUntil (null on an ungated row) — `npm run swap`'s gate-clear hook reads gateRef off this to decide which rows a release actually cleared.",
    // 18 columns is far past what a terminal table holds, and the triage-
    // relevant ones (scope/severity/complexity) sit at the END of the row, so
    // the automatic leftmost-fits fallback would hide exactly the wrong half.
    prettyColumns: ["feedbackId", "kind", "scope", "status", "severity", "complexity", "description"],
    errors: [
      { origin: "client", exit: 4, match: ["use only one of", "must be one of"], meaning: "Validation", remedy: "use only one of --all / --unresolved / --status; likewise only one claim filter (--unclaimed / --mine / --claimed-by / --held) and only one of --gated / --ungated; --status values must be open|reviewed|applied|dismissed; --kind must be improvement|bug|idea|legal and --scope one of cli|app|jerry|bsg2|workspace|security|ops|impeccable|other (both STRICT — they are server-side SQL filters, so an unknown value would return an empty list that reads as 'nothing filed')" },
      intParseErr("--max-complexity", "pass an integer 1-5"),
      limitErr("pass a positive integer; this command caps at 200 — page past it with --offset"),
      intParseErr("--offset", "pass a non-negative integer row offset", 0),
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "Default scope is the active bucket (open + reviewed). Pass --all to include closed (applied/dismissed) items, or --status applied to target them.",
      "--search is a server-side substring filter added in a later backend version; against an older backend it is silently ignored (the list returns unfiltered) — deploy-gated.",
      "--complexity / --max-complexity filter on the AI-triage complexity estimate (1-5). `--max-complexity 3 --unresolved` is the autonomously-workable backlog for a batch-fix agent; also deploy-gated (ignored by an older backend).",
      "--severity is deploy-gated like the others, but its silent-ignore failure points the WRONG WAY, so this one is CHECKED rather than merely documented: an older backend ignores the param and answers unfiltered, which for `--severity none` returns every active row and reads as 'the whole queue is ungraded'. The CLI compares the rows against what was asked and, on a mismatch, emits a loud stderr warning plus an envelope `hint` saying the results are unfiltered. An EMPTY result is not flagged — a genuinely empty slice and a filtered-out one look identical, so use `ib dev feedback count` (bySeverity/ungraded) to tell them apart.",
      "--oldest sorts createdAt ASC so the automated triage loop drains the backlog oldest-first (FIFO) instead of favouring the newest reports it reads first; the human default stays newest-first. Layer it under a priority filter (e.g. `--kind bug --oldest`) to keep breakages ahead of age.",
      "Each row carries claimState (free|held|mine). An expired claim reads as `free` — the lease is evaluated against the clock, never a stored flag, so a lapsed 24h claim reappears here automatically. A row that would read `mine` instead reads `held` (+ a stderr warning) when the caller's identity is the derived user@host fallback (no $IB_CLAIM_ID/--by/ctx set) — that label is shared by every such session on the host, so `mine` cannot be proven (fb#901).",
      "--held (fb#886) is deploy-gated with the same CHECKED contract as --severity, because its silent-ignore also points the wrong way: an older backend ignores the param and answers unfiltered, which reads as 'everything is claimed'. On a mismatch (a returned row with no live lease) the CLI emits a loud stderr warning plus an envelope `hint`; filter client-side on claimState there instead.",
      "--ungated (fb#1209) has NO server-side param — the backend's gated filter has no negation value — so it runs CLIENT-SIDE over the complete per-status walk (a lone --status walks that status, --all fans out over all four). That routing is what keeps it exact against the 200-row cap; filtering one capped page is the fb#536/fb#1198 under-report class.",
      "PARTLY-SHIPPED ROWS (fb#647): a row can carry `changelogLinks` and still be open — that is a fix recorded with `ib dev changelog add --feedback <id> --no-resolve`, which links the shipped half WITHOUT closing the row. Any linked row that is still OPEN or REVIEWED is also named in a one-line stderr note (a closed row always has a `resolves` link, so those are not worth saying). Read the entry (`ib dev changelog get <id>`) BEFORE claiming it, or you will re-investigate work that already shipped. Deploy-gated: an older backend sends no links and the note simply does not fire — its absence never means 'nothing shipped'.",
    ],
    examples: [
      "ib dev feedback list",
      "ib dev feedback list --all",
      "ib dev feedback list --status applied --scope cli",
      "ib dev feedback list --kind bug --limit 20",
      "ib dev feedback list --search IDOR",
      "ib dev feedback list --max-complexity 3 --unresolved",
      "ib dev feedback list --scope cli --oldest",
      "ib dev feedback list --severity none --unresolved --oldest",
      "ib dev feedback list --gated",
      "ib dev feedback list --gated deploy",
      "ib dev feedback list --gated owner-decision",
      "ib dev feedback list --gated owner-action --all",
      "ib dev feedback list --gated owner-any --unresolved",
      "ib dev feedback list --ungated --unclaimed --max-complexity 2",
      "ib dev feedback list --severity critical --unresolved",
      "ib dev feedback list --held",
    ],
  },
  {
    command: "ib dev feedback lint",
    description:
      "Audit the feedback queue for INCOMPLETE rows — the completeness twin of `count`, which only says how many rows exist in each bucket. Developer-only. Read-only, whole-table (no filters: a filter would let a clean slice read as a clean queue). Returns one finding per problem; an empty list means the queue is clean.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "strict", type: "boolean", description: "Exit 1 if any warn-level finding exists (CI / scheduled-runner gate). info-level findings never gate — see the notes for why the split is drawn where it is." },
    ],
    outputShape:
      "{ items: [{ feedbackId, issue, detail, severity }], nextCursor: null, count }. issue = ungraded | stale-claim | closed-no-resolution | applied-no-changelog; severity = warn (gates --strict) | info.",
    prettyColumns: ["feedbackId", "issue", "severity", "detail"],
    errors: [
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(404, "Not found", "this backend predates `feedback lint` — the route falls through to GET /api/feedback/:id and its numeric-id guard answers 404. ⚠ Do NOT reach for `--severity none` as the fallback: it ships in the SAME backend change, so a backend that 404s here is exactly the one that IGNORES that filter and answers with every active row. Until the deploy lands, fetch `ib dev feedback list --unresolved --full` and filter `severity == null` / `complexity == null` client-side (accepting the 200-row cap), or point --endpoint at a backend that has both."),
      apiErr(500, "Backend error", "a 500 here is usually the SAME deploy gate rather than a fault: a backend old enough to also predate the numeric-id guard reaches SQL as id='lint' and 500s instead of 404ing. Check `ib version`; retrying will not help if the route is simply absent."),
    ],
    notes: [
      "The four issues: `ungraded` = an ACTIVE row (open/reviewed) missing severity and/or complexity — the detail says which. `stale-claim` = an active row whose lease expired but still names a holder. `closed-no-resolution` = an applied/dismissed row with no resolution text. `applied-no-changelog` = an applied row with no devChangelogFeedback link, i.e. a fix that shipped without a changelog entry.",
      "WARN vs INFO is chosen so --strict stays actionable rather than permanently red. warn = `ungraded` + `stale-claim`, which a grooming run and the SessionEnd release hook drive to zero, so a red --strict means act today. info = the two documentation-gap issues, which are a historical backlog no single run clears; gating on those would make the lint always-red, and an always-red check gets rubber-stamped instead of read.",
      "Runs SERVER-side over the whole table on purpose. The CLI's own route to this answer is a page capped at 200 rows whose drops are the OLDEST — i.e. the longest-neglected rows, exactly the ones a completeness audit exists to surface (fb#536, fb#605).",
      "`ungraded` is what the groom-feedback-triage skill clears. Use `ib dev feedback list --severity none` / `--complexity none` to pull the actual rows once lint says they exist.",
    ],
    seeAlso: ["ib dev feedback count", "ib dev feedback list", "ib glossary lint"],
    examples: [
      "ib dev feedback lint",
      "ib dev feedback lint --strict",
    ],
  },
  {
    command: "ib dev feedback get",
    aliases: ["ib dev feedback show"],
    description:
      "Fetch one feedback row by id (developer-only).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" }],
    flags: [
      {
        name: "full",
        type: "boolean",
        description:
          "Accepted for cross-command consistency; get always returns the full row (no-op).",
      },
    ],
    outputShape: "The full feedback row { feedbackId, kind, scope, status, description, command, errorText, cliVersion, context, resolution, createdAt, claimedBy, claimExpiresAt, claimState (derived: free|held|mine, same fb#901 downgrade as `list`), related: [{feedbackId, relationType, direction, note, status, severity, firstLine, createdBy, createdAt}] (deploy-gated: absent on an older backend), ... }",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — if the id exists in devChangelog the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "The id accepts an optional `fb#` type anchor (e.g. `fb#42`); a `cl#` id is rejected up front (exit 4, code WRONG_REF_TYPE) with the corresponding `ib dev changelog get` command in the hint — feedback #230. A bare id that is actually a changelog id 404s here and the error hint points at the changelog command.",
      "`related` (relations design 2026-08-31) lists every row LINKED via `ib dev feedback link`, each with the edge's `direction` (out = this row names the other; in = the other names this one). Absent entirely on a backend that predates it.",
    ],
    seeAlso: ["ib dev feedback list", "ib dev feedback link", "ib dev changelog get"],
    examples: ["ib dev feedback get 42", "ib dev feedback get fb#42"],
  },
  {
    command: "ib dev feedback cluster",
    description:
      "Fetch the fix-together component for a feedback row: every row reachable through duplicate + same-root-cause edges (developer-only, read-only). Deploy-gated on puminet5api.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor" }],
    flags: [],
    outputShape:
      "ListEnvelope<{feedbackId,status,kind,scope,severity,complexity,claimState,firstLine,claimedBy,claimExpiresAt,...}> (+truncated when a walk bound cut the component)",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — or the backend predates this route (relations design 2026-08-31; deploy-gated on puminet5api), in which case even a valid id 404s since GET /api/feedback/:id/cluster doesn't exist yet. Check `ib version`."),
      ...COMMON_AUTH_ERRORS,
    ],
    notes: [
      "cluster = duplicate + same-root-cause edges only; related/blocks edges are context, not part of the fix-together set — see `get`'s `related`.",
      "`truncated: true` means a walk bound cut the component — treat the result as suspect data, not a complete (bigger) fix.",
    ],
    seeAlso: ["ib dev feedback link", "ib dev feedback get"],
    examples: ["ib dev feedback cluster 42"],
  },
  {
    command: "ib dev feedback resolve",
    description:
      "Triage a feedback row: set its status and/or attach a resolution note (developer-only). This IS a real write — blocked under --read-only (exit 3). --dry-run previews the update body client-side without sending.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [
      { name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" },
      { name: "note", type: "string", required: false, description: "The resolution note, positionally — the same field as --note, so `resolve 42 --status applied -- \"…\"` works exactly like `--note \"…\"`. Mirrors its sibling `ib dev feedback create <description>`, which has always taken its prose positionally (fb#583). Giving both is fine: distinct values merge, identical ones store once." },
    ],
    flags: [
      { name: "status", type: "string", description: "open | reviewed | applied | dismissed", allowed: [...FEEDBACK_STATUSES] },
      { name: "note", type: "string", description: "Resolution note stored on the row (same field as the positional)" },
      { name: "reason", type: "string", description: "Alias for --note — here it IS the stored note, NOT the X-Action-Reason audit header" },
      { name: "resolution", type: "string", description: "Alias for --note (matches the output field name); distinct values across the three note flags are merged into one note" },
      { name: "from-json", type: "string", description: "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: status, note (or reason/resolution). An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the only way to pass a note containing quotes on Windows PowerShell." },
      { name: "also", type: "string", description: "Comma-separated feedback ids to apply the SAME --status/--note to (relations design 2026-08-31). A row held LIVE by another agent is skipped and reported, not fatal — check `failed` in the output, not just the exit code." },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
      { name: "full", type: "boolean", description: "Return the full updated row instead of the compact ack" },
    ],
    outputShape:
      "A compact ack { feedbackId, status, updatedAt, resolution } (resolution capped at 200 chars; the full row with --full). A note-only call that leaves the row open/reviewed adds hint naming the closing statuses. With --also: also: [{feedbackId, ok, status?, error?}], failed (count). With --dry-run: { dryRun:true, wouldSend:{ method, path, body }, alsoWouldSend? }.",
    errors: [
      // Both client rows sit at exit 4, so EACH must carry `match` — an
      // unmatched row would win by exit alone and serve the wrong remedy
      // (the fb#305/#306 ambiguity).
      { origin: "client", exit: 4, match: ["provide --status", "--status must be one of"], meaning: "Validation", remedy: "provide --status and/or --note; status must be a known value" },
      // Since fb#583 ONE excess positional is the note, so reaching this row
      // takes TWO or more — which on Windows PowerShell means the shell split
      // the note rather than the caller passing two notes on purpose.
      { origin: "client", exit: 4, match: "too many arguments", meaning: "The shell split the note on its inner double-quotes (typical on Windows PowerShell) — a single positional note is accepted", remedy: "pass the note via --from-json <file|-> instead of argv" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — a bare id that is actually a changelog id 404s here and the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "The note can be POSITIONAL or a flag — `resolve 42 --status applied -- \"…\"` and `resolve 42 --status applied --note \"…\"` are the same call (fb#583). The positional matches `ib dev feedback create <description>`; the two sibling commands used to disagree about where prose goes, which is the whole reason this was worth changing.",
      "--note/--reason/--resolution and the positional write the SAME stored note. Passing several with different values merges them (joined in positional→note→resolution→reason order) instead of dropping any — so mixing up --reason with the audit header loses nothing, and repeating the same text stores it once.",
      "A note WITHOUT --status does NOT close the row — it stays open/reviewed and the ack carries a hint saying so; pass --status applied|dismissed to close (feedback #270).",
      "The two ways to close a row have OPPOSITE defaults, so don't assume this one closes: `ib dev changelog add --feedback <id>` closes it for you (status=applied plus a `Shipped: changelog #N` resolution), while this command leaves the status alone unless you pass --status. Recording the fix in the changelog is the one-call path (feedback #293). Note the one-call path only advances a row from `open` — if you set this row to `reviewed` first, a later `changelog add --feedback` will preserve that and tell you so, rather than claiming shipped work that is only staged (fb#517). And since fb#880: on an ALREADY-resolved row, `changelog add --feedback` links as a cross-reference and keeps the resolver — re-own deliberately with `--take-resolve`.",
      "SHELL QUOTING (fb#327): a resolution note quotes commands and errors, and a quote-split can even store the note TRUNCATED at the first quote — use --from-json <file|-> for any quote-bearing note; see `ib help shell-quoting`.",
      "FIXED ONLY PART OF IT? Do not choose between closing the row and recording nothing — there is a third path (fb#647). `ib dev changelog add --feedback <id> --no-resolve` links the entry with role `references`, recording the shipped half WITHOUT touching the status; then `ib dev feedback update <id> --append-description \"shipped: X; remaining: Y\"` (and `--scope` if the residue belongs to another repo) narrows the row to what is left. The link is what makes it legible: `feedback list` and `claim` both name a linked row, so the next agent reads your entry instead of rediscovering it. Leaving a partial fix unrecorded is the failure this exists to prevent — it costs every later agent the same investigation.",
    ],
    seeAlso: ["ib dev changelog add", "ib dev feedback list", "ib dev feedback update"],
    examples: [
      'ib dev feedback resolve 42 --status applied --note "added row counts in CLI v1.3"',
      'ib dev feedback resolve 42 --status applied -- "the note works positionally too"',
      'ib dev feedback resolve 42 --status dismissed --note "by design"',
      "ib dev feedback resolve 42 --from-json ./resolution.json",
      "ib dev feedback resolve 42 --from-json ./resolution.json --status dismissed",
      'ib dev feedback resolve 42 --status applied --note "fixed together" --also 43,44',
    ],
  },
  {
    command: "ib dev feedback link",
    description:
      "Link two feedback rows as duplicate | same-root-cause | related | blocks (developer-only). A REAL write — blocked under --read-only. --dry-run previews client-side. Deploy-gated on puminet5api.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [
      { name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor" },
      { name: "relatedId", type: "number", description: "The OTHER feedbackId to link to" },
    ],
    flags: [
      { name: "type", type: "string", required: true, description: "duplicate/blocks are DIRECTED (id→relatedId); same-root-cause/related are symmetric", allowed: [...FEEDBACK_RELATION_TYPES] },
      { name: "note", type: "string", description: "Optional free-text note stored on the relation" },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape: "{ relationId, feedbackId, relatedFeedbackId, relationType, note, createdBy, createdAt } (HTTP 201). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, match: "cannot link a feedback row to itself", meaning: "id and relatedId are the same row", remedy: "pass two DIFFERENT feedback ids — the server's own 400 for this is defense-in-depth, not the primary guard" },
      { origin: "client", exit: 4, match: ["--type is required", "must be one of", "invalid feedbackid"], meaning: "Validation", remedy: "--type is required and must be duplicate|same-root-cause|related|blocks; both ids must be positive integers ('invalid feedbackId' fires for EITHER positional — parseRefId names the ref field, not the argument)" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check both ids via `ib dev feedback list`/`get` — either row is missing"),
      apiErr(409, "Already linked", "unlink first (`ib dev feedback unlink <id> <relatedId>`) to change the relation type"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib dev feedback unlink", "ib dev feedback cluster", "ib dev feedback get"],
    examples: [
      'ib dev feedback link 10 20 --type duplicate --note "same argv-split root"',
      "ib dev feedback link 10 20 --type related --dry-run",
    ],
  },
  {
    command: "ib dev feedback unlink",
    description:
      "Remove a link between two feedback rows, either direction (developer-only, idempotent). A REAL write — blocked under --read-only. --dry-run previews client-side. Deploy-gated on puminet5api.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [
      { name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor" },
      { name: "relatedId", type: "number", description: "The OTHER feedbackId the link was made with" },
    ],
    flags: [
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape: "{ feedbackId, relatedFeedbackId, deleted }. deleted:false means no link existed for either id/direction — NOT an error (no 404 case: a missing link, or a missing row, both just answer deleted:false).",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib dev feedback link", "ib dev feedback cluster"],
    examples: ["ib dev feedback unlink 10 20"],
  },
  {
    command: "ib dev feedback update",
    description:
      "Edit a filed row's classification (--scope/--kind/--severity/--complexity/--gate-kind/--gate-ref/--gate-until) or its --description (developer-only). The correction twin of `resolve` (which sets status/note) — same PUT /api/feedback/:id endpoint. A real write, blocked under --read-only (exit 3). --dry-run previews the body client-side. Deploy-gated: an older backend ignores these fields and 400s on a status-less body.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor (e.g. `fb#42`); a `cl#` id is rejected (exit 4) with the changelog command to use (feedback #230)" }],
    flags: [
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other", allowed: [...FEEDBACK_SCOPES] },
      { name: "kind", type: "string", description: "improvement | bug | idea | legal", allowed: [...FEEDBACK_KINDS] },
      { name: "severity", type: "string", description: "critical | major | minor | cosmetic — same STRICT enum as `feedback create`: five synonyms (high/medium/low/blocker/trivial) are named back to you in the exit-4 `did you mean`, none is accepted. See `ib help severity`", allowed: [...FEEDBACK_SEVERITIES] },
      { name: "complexity", type: "number", description: "1-5 agent-triage estimate — promote/downgrade after investigation (see `ib help complexity`)" },
      { name: "description", type: "string", description: "REPLACE the freetext description (destructive — the filed report is overwritten; use --append-description to add to it)" },
      { name: "gate-kind", type: "string", description: `What this row is waiting for: deploy|soak|legal|owner-decision|owner-action|backlog (bare \`owner\` is legacy, still accepted). ${clearHint("--gate-kind")}`, allowed: [...FEEDBACK_GATE_KINDS] },
      { name: "gate-ref", type: "string", description: `Gate pointer: deploy repo@sha · legal TYPE@version (the version being superseded) · owner-decision/owner-action free text naming the call or the task. ${clearHint("--gate-ref")}` },
      { name: "gate-until", type: "string", description: `Wake date (YYYY-MM-DD, an ISO datetime, or today/yesterday/tomorrow) for --gate-kind soak|backlog, validated CLIENT-SIDE (fb#446). ${clearHint("--gate-until")}` },
      { name: "body", type: "string", description: "Alias for --description (free text, not JSON); if both are passed, they must match" },
      { name: "append-description", type: "string", description: "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the original report intact" },
      { name: "reason", type: "string", description: "Audit why-string (fb#801) — no dedicated field to carry it, so it merges into --append-description (deduped if identical); rejected alongside a full --description replace" },
      { name: "from-json", type: "string", description: "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: scope, kind, severity, complexity, description (or body), appendDescription, gateKind, gateRef, gateUntil. An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the only way to pass prose containing quotes on Windows PowerShell." },
      { name: "dry-run", type: "boolean", description: "Print the update body without sending (client-side)" },
      { name: "full", type: "boolean", description: "Return the full updated row instead of the compact ack" },
    ],
    outputShape:
      "A compact ack { feedbackId, scope, kind, severity, complexity, gateKind, gateRef, gateUntil, updatedAt, description? } (description capped at 200 chars; the full row with --full). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      // Three client rows share exit 4, so EACH needs `match` — an unmatched row
      // wins by exit alone and serves the wrong remedy (the fb#305/#306 ambiguity
      // that error-origins.test.ts enforces).
      { origin: "client", exit: 4, match: ["provide at least one of", "must be one of", "must be an integer", "must be non-empty", "mutually exclusive", "not both with different values", "cannot be combined"], meaning: "Validation", remedy: "provide at least one of --scope/--kind/--severity/--complexity/--description/--append-description/--reason/--gate-kind/--gate-ref/--gate-until; enum values must be valid; --complexity must be an integer 1-5; --description is mutually exclusive with --append-description and with --reason" },
      { origin: "client", exit: 4, match: "must be YYYY-MM-DD or an ISO datetime", meaning: "--gate-until is not a parseable date — validated CLIENT-SIDE (fb#446), before the backend (which does not validate it at all)", remedy: "pass YYYY-MM-DD, a full ISO datetime, today/yesterday/tomorrow, or empty (--gate-until=) to clear it" },
      { origin: "client", exit: 4, match: "too many arguments", meaning: "The shell split the description on its inner double-quotes (typical on Windows PowerShell)", remedy: "pass the text via --from-json <file|-> instead of argv" },
      { origin: "client", exit: 4, match: "--from-json", meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key", remedy: "the error says WHICH of the four: an unopenable path, a JSON syntax error (no field has been read yet, so the key names are not the problem), a root that is not an object, or an unknown / wrong-typed key. Only the last two are about field names" },
      apiErr(
        400,
        "Backend predates the owner gate split",
        "this backend's gateKind vocabulary has no owner-decision/owner-action (they ship in puminet5api@1.33.1, production since 2026-09-03) — against it use bare --gate-kind owner, the legacy value it still accepts (fb#1224)",
        "gatekind must be one of"
      ),
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list` — a bare id that is actually a changelog id 404s here and the error hint names the changelog command (feedback #230)"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "--description REPLACES the stored report; --append-description ADDS to it (read-merge-write, blank-line separated). Prefer append for later commentary — a replace that goes wrong destroys the original evidence, and feedback rows have no version history to recover it from. The two are mutually exclusive (exit 4).",
      "SHELL QUOTING (fb#332): --description OVERWRITES the filed report, so a quote-split truncation is destructive — use --from-json <file|-> for long or quote-bearing text; see `ib help shell-quoting`.",
      "--reason has no dedicated audit field here (unlike claim/release) — it merges into --append-description, same idiom `resolve` uses for --reason on its note. Combine it with --description (a full replace) instead and it exits 4.",
    ],
    seeAlso: ["ib dev feedback resolve", "ib dev feedback gate-clear"],
    examples: [
      "ib dev feedback update 42 --scope security",
      "ib dev feedback update 42 --kind bug --severity major",
      "ib dev feedback update 42 --complexity 4",
      "ib dev feedback update 42 --from-json ./correction.json",
      'ib dev feedback update 42 --append-description "Confirmed on prod 2026-08-06; root cause is the cache key."',
      'ib dev feedback update 42 --gate-kind deploy --gate-ref "puminet5api@a930ccaf"',
      "ib dev feedback update 42 --gate-kind soak --gate-until tomorrow",
      "ib dev feedback update 42 --gate-kind=",
    ],
  },
  {
    command: "ib dev feedback claim",
    description:
      "Take (or renew) the work claim on a feedback row so no other agent starts the same item (developer-only). Mutual exclusion is REAL: the backend acquires via one atomic UPDATE, so exactly one of two racing agents wins and the other gets 409. A REAL write — blocked under --read-only.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    args: [{ name: "id", type: "number", description: "feedbackId — accepts an optional `fb#` anchor" }],
    flags: [
      { name: "by", type: "string", description: "The claiming agent/session label. Defaults to the hosted bridge's per-caller identity, then $IB_CLAIM_ID, then user@host. Every agent authenticates as the same person, so this label is the ONLY thing that distinguishes sessions — pass your session short id. Over MCP ib_exec this is now an OVERRIDE rather than a requirement: the bridge supplies the MCP session id as `mcp:<uuid>` (fb#616). Over POST /api/cli/exec, pass `claimId` in the request body or --by here — that path is stateless and has no identity to derive. If the backend can supply neither, `claim` REFUSES rather than issuing a lease keyed on a label every hosted caller shares." },
      { name: "ttl-hours", type: "number", description: "Lease length in hours, 1-24 (default 24). The 24h ceiling is ABSOLUTE: it is measured from your FIRST acquire, so renewing cannot extend past it." },
      { name: "steal", type: "boolean", description: "Take a row that is under another agent's LIVE claim. For human recovery; normal contention should pick a different item instead." },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ],
    outputShape:
      "The claimed feedback row, including claimedBy, claimedAt, claimExpiresAt and `changelogLinks: [{changelogId, role}]`.",
    errors: [
      // The 1-24 range check is SERVER-side (feedback.js claim(): sendValidationError
      // -> HTTP 400), not client-side — runFeedbackClaim forwards ttlHours unchecked.
      // An `origin:"client"` row here is unreachable (matchClientRow only runs when
      // statusCode===0; a real 400 never hits it), which silently drops the remedy
      // for the most likely misuse. Must key on `http:400` so matchHttpRow finds it.
      apiErr(400, "Validation", "--ttl-hours must be 1-24", "ttlhours"),
      intParseErr("--ttl-hours", "pass an integer 1-24"),
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list`"),
      apiErr(409, "Already closed", "the row is done — read the linked entry with `ib dev changelog get <id>`; reopen it with `ib dev feedback resolve <id> --status open` first if it should not be", "already closed"),
      apiErr(409, "Already claimed by another session", "the message names the holder and expiry — pick another item with `ib dev feedback list --unclaimed`, or pass --steal to take it anyway", "claimed by"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Claiming is how concurrent AI agents avoid duplicating work. Browse with `ib dev feedback list --unclaimed`, choose an item yourself, then claim it. On a 409, pick a different item — do not wait.",
      "Re-claiming an item you already hold is idempotent and doubles as the RENEWAL path; there is no separate renew command. It cannot extend the lease past 24h from your first acquire.",
      "An abandoned claim frees itself: expiry is evaluated at read time, so after 24h the row is claimable again with no sweeper and no manual cleanup.",
      "Closing a row (`resolve --status applied|dismissed`) releases the claim automatically.",
      "If the row already carries changelog links, claiming it prints a one-line stderr note naming them (fb#647). An open row CAN have links: `ib dev changelog add --feedback <id> --no-resolve` records a partial fix without closing the row, so part of the item may already have shipped. Read the named entry (`ib dev changelog get <id>`) before starting — that note exists because an agent once spent a whole investigation cycle rediscovering a half that had already shipped.",
    ],
    seeAlso: ["ib dev feedback release", "ib dev feedback list", "ib dev feedback resolve"],
    examples: [
      "ib dev feedback claim 42 --by c6b96c",
      "ib dev feedback claim 42 --by c6b96c --ttl-hours 4",
      "ib dev feedback claim 42 --by c6b96c --steal",
    ],
  },
  {
    command: "ib dev feedback release",
    description:
      "Release a work claim you hold, so another agent can pick the item up (developer-only). --all releases every claim held by your label — what a session should do on exit. A REAL write — blocked under --read-only.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    args: [{ name: "id", type: "number", required: false, description: "feedbackId — omit when using --all" }],
    flags: [
      { name: "by", type: "string", description: "The holder label. Defaults to the hosted bridge's per-caller identity, then $IB_CLAIM_ID, then user@host — must match the label used to claim. Over MCP ib_exec the bridge supplies `mcp:<session-uuid>` automatically (fb#616), so this is an override; over POST /api/cli/exec supply `claimId` in the body or --by here. Without any identity, `--all` REFUSES (it would release every hosted caller's claims, not just yours); releasing a single named id is still allowed." },
      { name: "all", type: "boolean", description: "Release EVERY claim held by this label instead of one row" },
      { name: "reason", type: "string", description: "Audit-log reason (X-Action-Reason)" },
    ],
    outputShape: "{ feedbackId, released:true } for one row; { by, released:<count> } with --all.",
    errors: [
      { origin: "client", exit: 4, match: "provide a feedbackid", meaning: "Validation", remedy: "pass a feedbackId, or --all to release every claim" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib dev feedback list`"),
      apiErr(409, "You do not hold that claim", "the label you asked as does not match the holder. Set $IB_CLAIM_ID to the label you claimed under and retry — that is the mechanism `resolve`/`update` also prove holdership with, and they have no --by flag at all. `--by <label>` overrides it for a one-off call. Check the current holder with `ib dev feedback get <id>`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Releasing is an optimisation, not the correctness mechanism — an abandoned claim expires on its own after 24h. Release so the item frees in seconds instead.",
      "IDENTITY IS PER-INVOCATION, and an unset one is INVENTED rather than refused (fb#652/fb#695). Each shell invocation resolves the label independently — explicit --by, then the hosted bridge's ctx, then $IB_CLAIM_ID, then a `user@host` fallback — so an agent that exported IB_CLAIM_ID in one tool call and released in another asks as a DIFFERENT holder. The single-id form then 409s naming a label you never chose; `--all` is worse, because it answers `{ released: 0 }` with exit 0, which reads as \"you held nothing\". Both cases now say on stderr that the label was derived. Set IB_CLAIM_ID in the same invocation as the release.",
    ],
    seeAlso: ["ib dev feedback claim", "ib dev feedback list"],
    examples: [
      "ib dev feedback release 42 --by c6b96c",
      "ib dev feedback release --all --by c6b96c",
    ],
  },
  {
    command: "ib dev feedback count",
    description:
      "Aggregate counts of filed feedback by status, kind, scope and severity, plus the claim split and how many rows still lack a complexity or severity grade (developer-only). The cheapest way to answer \"is there any open feedback?\" — a tiny fixed-size response instead of a row dump. Aggregated server-side, so the totals stay correct at any volume. STATUS SCOPE mirrors `list` (fb#1192): the DEFAULT is the active bucket (open+reviewed) — closed rows are where every settled NULL sits, and whole-table ungraded/unestimated used to read as a backlog that does not exist; pass --all for the whole-table number.",
    // `stats` mirrors the backend route this wraps (GET /api/feedback/stats), so
    // a caller who read the route table or the module reaches for that spelling
    // (fb#611). It previously dead-ended on exit 4 and — worse — pointed at
    // `ib stats`, an unrelated delivery-statistics domain.
    aliases: ["ib dev feedback stats"],
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "kind", type: "string", description: "improvement | bug | idea | legal — count only this kind", allowed: [...FEEDBACK_KINDS] },
      { name: "scope", type: "string", description: "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — count only this scope", allowed: [...FEEDBACK_SCOPES] },
      { name: "status", type: "string", description: "open | reviewed | applied | dismissed, or a comma-separated list — count only these statuses; mutually exclusive with --unresolved/--all", allowed: [...FEEDBACK_STATUSES] },
      { name: "unresolved", type: "boolean", description: "Shortcut for --status open,reviewed (un-closed rows) — same as the default; mutually exclusive with --status/--all" },
      { name: "all", type: "boolean", description: "Count EVERY status (the whole table) — restores the pre-fb#1192 behaviour; mutually exclusive with --status/--unresolved" },
    ],
    outputShape:
      "{ total, byStatus: { open, reviewed, applied, dismissed }, byKind, byScope, bySeverity, byClaim: { held, free }, unestimated, ungraded, truncated?, hint? }. EVERY key counts the STATUS SCOPE — the active bucket (open+reviewed) by default, the whole table under --all — so the completeness scalars finally answer \"what still needs triage\": `unestimated` = complexity IS NULL in scope (pair with `list --complexity none`), `ungraded` = severity IS NULL in scope (pair with `list --severity none`); `bySeverity` buckets the graded rows and carries the NULLs under the key `ungraded`. `byClaim` (fb#888) is a live-lease split — `held` = claimedBy set AND unexpired, `free` = everything else including an expired lease — answering \"what is being worked right now?\" without pulling a page. bySeverity/byClaim/ungraded are deploy-gated: absent on an older backend, which is NOT the same as zero.",
    notes: [
      "DEFAULT IS THE ACTIVE BUCKET (fb#1192), mirroring `list` — whole-table ungraded/unestimated used to count settled NULLs on closed rows as backlog. --all restores the whole-table number; byStatus shows the scope.",
      "Status scoping is DEPLOY-GATED but CHECKED: a backend that ignores the `status` param is detected (out-of-set statuses in byStatus) and answered with the capped client-side rollup, scope honoured.",
      "DEPLOY-GATED (fb#536): needs /api/feedback/stats; an older backend falls back to the client-side rollup over 200-row pages and sets `truncated` with a hint — a LOWER BOUND whose drops are the OLDEST rows (`open` understated most).",
    ],
    errors: [
      { origin: "client", exit: 4, match: ["must be one of", "use only one of"], meaning: "Validation", remedy: "--kind must be improvement|bug|idea|legal, --scope one of cli|app|jerry|bsg2|workspace|security|ops|impeccable|other, --status values open|reviewed|applied|dismissed (all STRICT — they are server-side SQL filters, so an unknown value would report total:0 rather than an error). Use only one of --all / --unresolved / --status" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      ...COMMON_AUTH_ERRORS,
    ],
    seeAlso: ["ib dev feedback lint", "ib dev feedback list"],
    examples: [
      "ib dev feedback count",
      "ib dev feedback count --all",
      "ib dev feedback count --scope cli",
      "ib dev feedback count --kind legal",
      "ib dev feedback count --status applied",
      "ib dev feedback count --unresolved",
    ],
  },
  {
    command: "ib dev feedback gate-clear",
    description:
      "Close every ACTIVE row whose gate matches --kind and --ref-prefix, and whose gateRef is not itself --cleared-ref (developer-only). POST /api/feedback/gates/clear. A REAL write — blocked under --read-only. --dry-run previews the body client-side; the route has no server-side X-Dry-Run guard. NOT a command you type by hand day to day — `npm run swap` calls this automatically after a deploy gate clears; the legal gate is closed by `ib legal activate` server-side and never reaches this route.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    mutates: true,
    dryRunKind: "client",
    flags: [
      { name: "kind", type: "string", description: "deploy | legal — narrower than the full gate-kind vocabulary on purpose: only these two auto-close (soak/owner/backlog close by a human calling `resolve`/`update`).", allowed: [...FEEDBACK_AUTO_CLOSE_GATE_KINDS] },
      { name: "ref-prefix", type: "string", description: "Scope the clear to gateRefs starting with this, e.g. `puminet5api@` (a repo) or `BETONIJERRY_TOS@` (a legal document type). LIKE-escaped server-side, so a literal `%`/`_`/`[` in the prefix is treated literally, not as a wildcard." },
      { name: "cleared-ref", type: "string", description: "The evidence that just landed, e.g. `puminet5api@1.31.0`. Rows whose OWN gateRef already equals this are excluded — that row recorded the state being waited for, not one still waiting for it." },
      { name: "dry-run", type: "boolean", description: "Print the payload without sending (client-side)" },
    ],
    outputShape: "{ cleared: number[] } — the feedbackIds actually closed (empty array when nothing matched, not an error). With --dry-run: { dryRun:true, wouldSend:{ method, path, body } }.",
    errors: [
      { origin: "client", exit: 4, match: ["is required", "must be one of"], meaning: "Validation", remedy: "--kind is required and must be deploy|legal; --ref-prefix and --cleared-ref are both required" },
      apiErr(400, "Validation", "the backend re-checks --kind against deploy|legal and rejects a non-string/empty --ref-prefix or --cleared-ref — this row is reachable only if a caller bypasses the CLI's own client-side guard (e.g. POST /api/cli/exec)"),
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "Driven by `npm run swap`, not typed by hand — after a slot swap it calls this once per repo with --ref-prefix `<repo>@` and --cleared-ref `<repo>@<version deployed>`. Find candidates first with `ib dev feedback list --gated deploy`.",
      "The legal gate is DIFFERENT: `ib legal activate` clears it server-side, in the same transaction that flips the document — never through this route (--kind legal here is a manual recovery lever).",
      "Idempotent: a terminal row is never touched twice, and the resolution is APPENDED, never replaced, so calling this again after a row already closed just clears zero more.",
    ],
    seeAlso: ["ib dev feedback list", "ib dev feedback update", "ib legal activate"],
    examples: [
      'ib dev feedback gate-clear --kind deploy --ref-prefix "puminet5api@" --cleared-ref "puminet5api@1.31.0"',
      'ib dev feedback gate-clear --kind deploy --ref-prefix "puminet5api@" --cleared-ref "puminet5api@1.31.0" --dry-run',
    ],
  },
];
