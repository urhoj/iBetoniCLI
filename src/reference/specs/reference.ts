// reference specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearHint, apiErr } from "./shared.js";

export const REFERENCE_SPECS: CommandSpec[] = [

  // ─── reference (1) ───────────────────────────────────────────────────────
  {
    command: "ib reference dump",
    description:
      "Emit the full command surface as JSON for one-shot AI ingestion. The universal 401/500 error contract is hoisted to a single top-level `commonErrors` block and stripped from each spec (it applied to every command) — read `commonErrors` together with each spec's command-specific `errors`. Flag/error rows repeated verbatim across many commands are likewise stored ONCE in top-level `sharedFlags`/`sharedErrors`: an \"@id\" string inside a spec's `flags`/`errors` array resolves to the row under that id (e.g. \"@reason\" -> sharedFlags.reason). Pass one or more domains (the token after `ib`, e.g. keikka) to narrow the commands map — STRONGLY preferred over the full surface (a one-domain dump is a fraction of the bytes). The full (no-domain) dump carries a `notice` field pointing this out. `glossary` (the term+synonyms vocabulary index) is OPT-IN via `--glossary`. `--commands-only` emits just { version, generatedAt, commonErrors, sharedFlags, sharedErrors, commands } for callers that already know the domain.",
    auth: "none",
    args: [
      {
        name: "domain...",
        type: "string",
        required: false,
        description:
          "Restrict the commands map to one or more domains (the token after `ib`, e.g. keikka). Multiple domains share a single primer. Unknown domain exits 4 listing valid domains.",
      },
    ],
    flags: [
      {
        name: "glossary",
        type: "boolean",
        description:
          "Include the term+synonyms vocabulary INDEX (fetched from the DB) under `glossary`. Off by default to keep the dump small; fetch definitions on demand with `ib glossary lookup <term>` / `ib glossary list`.",
      },
      {
        name: "commands-only",
        type: "boolean",
        description:
          "Emit only { version, generatedAt, commonErrors, commands } — drop the overview/topics/feedbackGuidance primer and skip the glossary fetch (no token needed). Fewer bytes per dump.",
      },
      {
        name: "lean",
        type: "boolean",
        description:
          "Drop each command's `notes`/`seeAlso` prose (KEEPS `examples`) — ~25k fewer tokens on the full surface. For a whole-surface scan you get what exists + how to call it; fetch the dropped caveats/cross-refs per-command via `ib <command> --help`. Composes with --commands-only and domain filters.",
      },
    ],
    outputShape:
      "{ version, generatedAt, commonErrors: CommandError[], sharedFlags: { id: CommandFlag }, sharedErrors: { id: CommandError }, notice?, overview, glossary, feedbackGuidance, topics, commands: { '<command>': CommandSpec } } — with --commands-only: { version, generatedAt, commonErrors, sharedFlags, sharedErrors, commands }; with --lean each spec drops notes/seeAlso (examples kept). `commonErrors` (401/500) applies to EVERY command and is omitted from each spec's `errors`. A spec's `flags`/`errors` array may contain \"@id\" reference STRINGS — resolve each in sharedFlags/sharedErrors (rows repeated across many commands, stored once). `notice` appears only on the full (no-domain) dump. `glossary` is the term+synonyms INDEX only and is EMPTY unless `--glossary` is passed; fetch a definition with `ib glossary lookup <term>` or all of them with `ib glossary list`.",
    errors: [
      { origin: "client", exit: 4, meaning: "Unknown domain", remedy: "run `ib commands` (no arg) to see valid domains" },
      { origin: "client", exit: 1, meaning: "I/O error", remedy: "retry; check stdout pipe" },
    ],
    examples: [
      "ib reference dump keikka",
      "ib reference dump --lean --commands-only",
      "ib reference dump --glossary",
      "ib reference dump | jq .commonErrors",
    ],
  },
  {
    command: "ib reference detail get",
    description:
      "On-demand business/AI context for one command (DB-backed via /api/cli/command-catalog); exit 5 if none",
    auth: "any",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description: "Command path after `ib` (e.g. keikka latest)",
      },
    ],
    flags: [],
    outputShape: "{ command, summary, detail, hint }. exit 5 when unknown or no detail yet.",
    errors: [
      // Two DIFFERENT origins share exit 5, and they must stay separate rows so
      // hintForError can match each: the unknown-command guard is client-side
      // (statusCode 0, matched by exit), while "no detail yet" is a real HTTP 404
      // from the catalog route (matched by http). A single http-less row left the
      // 404 case falling through to the generic hint, which wrongly blamed the
      // active company — the catalog is global, not tenant-scoped (feedback #280).
      {
        origin: "client",
        exit: 5,
        meaning: "Unknown command (client-side guard)",
        remedy: "`ib commands` / `ib reference dump` for valid paths; or `<cmd> --help`",
      },
      {
        http: 404,
        exit: 5,
        meaning: "Known command, but no detail recorded yet",
        remedy:
          "no business-context detail is recorded for this command yet — fall back to `<cmd> --help`, which is self-contained; a developer can fill the catalog entry",
      },
    ],
    examples: [
      "ib reference detail get keikka latest",
      "ib reference detail get jerry check-address",
    ],
  },
  {
    command: "ib reference detail list",
    description:
      "List command-catalog entries, optionally ordered by stalest (DB-backed)",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [
      {
        name: "stalest",
        type: "number",
        description: "Return up to N entries sorted by least-recently reviewed",
      },
      {
        name: "domain",
        type: "string",
        description: "Only commands in this ib domain (e.g. attachment) — narrows BEFORE --stalest, so the budget isn't spent on unrelated commands",
      },
      {
        name: "with-detail",
        type: "boolean",
        description: "Include each entry's full detail text (adds a `detail` field per item), folding the per-command `reference detail get` into this one call. Needs the backend deployed; on an old backend the field is simply absent.",
      },
      { name: "needs-review", type: "boolean", description: "Only rows still needing grooming: aiConfidence below the threshold (or unassessed) AND not parked, oldest-first." },
      { name: "max-confidence", type: "number", description: "Threshold for --needs-review (default 90)." },
      { name: "search", type: "string", description: "Only rows whose command PATH contains this substring (case-insensitive). Client-side, so it works without a raw DB LIKE — the discover half of `reference detail delete`." },
      { name: "orphans", type: "boolean", description: "Only ORPHAN rows: keys whose command no longer exists in the live catalogue (re-homed/renamed leftovers). Same set as `reference detail lint`, but streamed as normal list rows so you can pipe → `delete`. Compose with --search to narrow." },
      { name: "limit", type: "number", description: "Return at most N rows. A client-side payload CAP applied LAST (after --search/--orphans), not a pager — there is no cursor, so the rows past N are simply not returned and `truncated: true` says so." },
    ],
    outputShape: "{ items: [{ command, summary, lastReviewed, runs, aiConfidence, needsHumanReview, detail? }], count, truncated? } — `detail` present only with --with-detail. --search/--orphans filter client-side and recompute count; `truncated: true` appears only when --limit actually cut rows.",
    errors: [
      { origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" },
      { origin: "client", exit: 4, match: "unknown domain", meaning: "Unknown --domain", remedy: "`ib commands` for valid domains" },
      { origin: "client", exit: 4, match: ["--limit", "--stalest"], meaning: "--limit / --stalest is not an integer >= 1", remedy: "pass a positive integer; a bad cap is rejected rather than dropped, which would silently return the WHOLE catalog" },
    ],
    notes: [
      "--search and --orphans are client-side post-filters (no backend deploy needed): the full catalog is fetched, then narrowed locally.",
      "NARROWING, not paging, is the model here: the backend returns the whole catalog in one shot and there is no cursor. Reach for --domain/--search/--needs-review/--stalest to ask a smaller question; --limit only caps the payload you get back (useful against --with-detail, which is ~154 large rows).",
      "--stalest and --limit are different caps: --stalest caps the SERVER page and orders it least-recently-reviewed first, --limit caps client-side AFTER the filters. Passing both gives you at most --limit of the stalest --stalest.",
      "Because --stalest caps the server page first, run --orphans WITHOUT --stalest for a full-catalog orphan scan (with --stalest it only scans that page).",
      "--orphans returns the same set as `reference detail lint` but as plain list rows, so `reference detail list --orphans` → `reference detail delete <key>` is a self-contained discover→prune workflow for an MCP/exec-only caller.",
    ],
    examples: [
      "ib reference detail list",
      "ib reference detail list --stalest 20",
      "ib reference detail list --stalest 10 --domain attachment",
      "ib reference detail list --stalest 10 --domain attachment --with-detail",
      "ib reference detail list --needs-review --max-confidence 90",
      "ib reference detail list --search 'dev bug'",
      "ib reference detail list --orphans",
      "ib reference detail list --with-detail --limit 20",
    ],
  },
  {
    command: "ib reference detail set",
    description:
      "Write summary and/or detail for one command in the command-catalog (developer only)",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description: "Command path after `ib` (e.g. keikka latest)",
      },
    ],
    flags: [
      {
        name: "summary",
        type: "string",
        description: "Short one-line summary stored in the catalog (≤160 chars, server-enforced)",
      },
      {
        name: "detail",
        type: "string",
        description: "Full markdown business-context detail (≤4000 chars, server-enforced). Don't recap flags/exit codes — those already render in `--help` from the spec; spend the budget on business context only found here.",
      },
      { name: "ai-confidence", type: "number", description: "Self-assessed completeness/correctness 0–100 (groom rubric). Omit on a human edit to reset the score." },
      { name: "needs-human-review", type: "boolean", description: "Park the row for a human (excludes it from --needs-review); set with a low --ai-confidence when blocked." },
      { name: "no-needs-human-review", type: "boolean", description: "Un-park the row — same effect as omitting --needs-human-review (both reset it), but explicit in the command line." },
      { name: "field", type: "string", description: "Edit-mode target field: summary | detail (default detail)" },
      { name: "replace", type: "string", description: "Edit mode: replace this literal text in the target field (exactly once unless --all)" },
      { name: "with", type: "string", description: 'Replacement for --replace (empty deletes the matched text; ' + clearHint("--with") + ")" },
      { name: "append", type: "string", description: "Edit mode: append text to the target field (verbatim)" },
      { name: "prepend", type: "string", description: "Edit mode: prepend text to the target field (verbatim)" },
      { name: "all", type: "boolean", description: "With --replace: substitute every occurrence" },
      { name: "from-json", type: "string", description: "Read the content fields from a JSON object file (or - for stdin); argv-safe route for prose containing Finnish ä/ö or an em-dash. Accepts summary, detail, aiConfidence, field, replace, with, append, prepend. Explicit flags outrank the file; unknown or wrong-typed keys exit 4." },
    ],
    outputShape: "{ command, runs, … } (backend response) | plain --dry-run: {dryRun:true, wouldSave:{command, exists, writes:{summaryChars?, detailChars?}, aiConfidence, needsHumanReview}, validation} | edit-mode --dry-run: {dryRun:true, command, field, matchCount?, addedLines, removedLines, sameContent, unified}",
    notes: [
      "--dry-run has two resolutions. EDIT mode (--replace/--append/--prepend) resolves CLIENT-side and never PUTs — safe on any backend. A plain --summary/--detail --dry-run is SERVER-side (X-Dry-Run) and DEPLOY-GATED: the PUT handler ignored the header until puminet5api shipped the wouldSave branch, so against an older backend a plain --dry-run WRITES FOR REAL and overwrites the entry (fb#286). Until that backend deploys, preview a full-field rewrite with `reference detail get` first, or use edit mode.",
      "Caps are validated BEFORE the dry-run branch, so an over-cap payload still exits 4 under --dry-run rather than reporting a would-be write.",
      "The save proc COALESCEs the CONTENT fields — an omitted --summary/--detail keeps its current value (" + clearHint("--summary") + "), which is why the dry-run's `writes` lists only the fields you sent. aiConfidence/needsHumanReview are DIRECT-assigned: omitting them RESETS the score and un-parks the row for the grooming routine.",
      "PASS PROSE VIA --from-json, NOT argv, whenever it contains a non-ASCII character (fb#613). Windows PowerShell reinterprets UTF-8 native arguments as latin1, so `Ylijäämäbetonin` is stored as `YlijÃ¤Ã¤mÃ¤betonin` while the call exits 0 and echoes a success payload. The corruption is invisible here in a way it is not elsewhere: this catalog is served to AI agents as authoritative, lives outside git, and nothing diffs or lints it. --needs-human-review and --all take no value, so they stay on argv alongside --from-json and are deliberately NOT accepted as JSON keys.",
    ],
    errors: [
      {
        origin: "client",
        exit: 5,
        meaning: "Unknown command",
        remedy: "`ib commands` for valid paths",
      },
      {
        http: 400,
        exit: 4,
        meaning: "summary >160 or detail >4000 chars (the message names the submitted length)",
        remedy: "Trim to the cap — cut any flag/exit-code recap first (it already renders in `--help`), keep the business context",
      },
    ],
    examples: [
      "ib reference detail set keikka list --summary 'Lists delivery orders' --reason 'initial fill'",
      "ib reference detail set keikka list --detail '## Keikka list\\nReturns ...' --reason 'update'",
      "ib reference detail set keikka list --replace '14 latest' --with '20 latest' --reason 'fix count' --dry-run",
      "ib reference detail set sijainti types --from-json ./detail.json --reason 'refresh catalog'",
    ],
  },
  {
    command: "ib reference detail delete",
    description:
      "Delete one command-catalog row by its exact key — prunes orphans of re-homed/removed commands (developer only)",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    reasonPolicy: "unless-dry-run",
    args: [
      {
        name: "command...",
        type: "string",
        required: true,
        description:
          "The exact stored command key after `ib` (e.g. ai conversation). Unlike get/set this is NOT validated against the live catalogue — that is precisely what lets you remove an orphan whose command no longer exists.",
      },
    ],
    flags: [],
    outputShape:
      "{ deleted } (rows removed, 0 or 1 — idempotent) | --dry-run: { dryRun:true, wouldDelete:{ command, exists }, validation }",
    errors: [
      apiErr(403, "Not a developer", "Requires isDeveloper / isSystemAdmin (server-enforced)"),
      { origin: "client", exit: 4, meaning: "Missing --reason on a real delete, or empty command path", remedy: "Pass --reason (or --dry-run to preview) and a command path" },
    ],
    examples: [
      "ib reference detail delete ai conversation --dry-run",
      "ib reference detail delete ai conversation --reason 'orphan: ai domain re-homed under dev'",
    ],
  },
  {
    command: "ib reference detail lint",
    description:
      "Audit the command-catalog for orphan rows — keys with no live command (re-homed/renamed leftovers); --strict for CI (developer only)",
    tier: "developer",
    auth: "any",
    flags: [
      { name: "strict", type: "boolean", description: "Exit 1 if any orphan row exists (for CI)" },
    ],
    outputShape:
      "{ items: [{ command, severity:'warn', kind:'orphan', summary, hint }], count } — one finding per catalog key with no live command",
    errors: [
      { origin: "client", exit: 1, meaning: "--strict and orphan rows found", remedy: "Prune each with `ib reference detail delete <key> --reason <r>`, or seed the re-homed command" },
      apiErr(403, "Not a developer", "Requires isDeveloper / isSystemAdmin (server-enforced)"),
    ],
    notes: [
      "Read-only: one GET of the whole catalog plus a local diff against the live command specs. The class behind fb#73 (`ib customer prh` re-homed to `ib opendata prh`).",
    ],
    seeAlso: ["ib reference detail delete", "ib reference detail list"],
    examples: ["ib reference detail lint", "ib reference detail lint --strict"],
  },
  {
    command: "ib commands",
    description:
      "Offline command discovery from the spec catalogue. No args = compact DOMAIN INDEX (~5 KB: every domain with leaf count, glossary blurb, runnable command paths). A domain arg, a filter flag, or --all returns the flat per-command list { command, description, permissions, isWrite }. Lighter than `ib reference dump` (the full surface). No auth, no network.",
    auth: "none",
    args: [
      {
        name: "domain",
        type: "string",
        required: false,
        description:
          "Only commands in this domain (the token after `ib`, e.g. keikka, jerry). Unknown domain exits 4 listing valid domains.",
      },
    ],
    flags: [
      {
        name: "mutations",
        type: "boolean",
        description: "Only commands that write (carry write-safety flags)",
      },
      {
        name: "reads",
        type: "boolean",
        description: "Only read-only commands (no writes)",
      },
      {
        name: "permission",
        type: "string",
        description:
          "Only commands whose required permissions contain this substring",
      },
      {
        name: "find",
        type: "string",
        description:
          "Keyword search: only commands whose PATH, description, or flag names contain this case-insensitive substring. Intent-first discovery when you know the concept but not the domain (driver lives under vehicle, geocode under sijainti) — offline, composes AND-wise with the domain arg and the other filters, returns the flat list. No match = empty list (exit 0); empty text exits 4.",
      },
      {
        name: "all",
        type: "boolean",
        description:
          "Full flat list of every command (~43 KB at 149 leaves). Default (no args) is the domain index.",
      },
      {
        name: "signatures",
        type: "boolean",
        description:
          "Add each command's compact call shape to the rows: `args` (`<name:type>` required, `[name:type]` optional) and `flags` signature strings (`--f <type>`; `<a|b>` allowed values; `!` required, `*` one-of-a-required-group). The middle rung between the flat list and `ib reference dump` — everything needed to CONSTRUCT most calls at a fraction of the dump's tokens; the envelope's leading `hint` spells out the notation and the write-safety trio. Triggers the flat list on its own; composes with the domain arg and every filter.",
      },
    ],
    outputShape:
      "no args: { hint, items:[{ domain, count, description|null, commands:[\"keikka list\", ...] }], nextCursor:null, count } (domain index) | with <domain> / --all / filters: { items: [{ command, description, permissions: string[], isWrite: boolean }], nextCursor: null, count } | --signatures adds per-row args?: string[] + flags?: string[] call-shape signatures and a leading envelope `hint` explaining the notation",
    errors: [
      { origin: "client", exit: 4, match: "mutually exclusive", meaning: "Bad flag combo", remedy: "--mutations and --reads are mutually exclusive" },
      { origin: "client", exit: 4, match: "unknown domain", meaning: "Unknown domain", remedy: "run `ib commands` (no arg) to see valid domains" },
      { origin: "client", exit: 4, match: "--find", meaning: "--find given empty/whitespace text (a PowerShell bare \"\" argument is dropped and swallows the next flag)", remedy: "pass real search text: ib commands --find geocode" },
    ],
    examples: [
      "ib commands",
      "ib commands keikka",
      "ib commands --all",
      "ib commands --find geocode",
      "ib commands vehicle --find driver --reads",
      "ib commands keikka --signatures",
      "ib commands --all --signatures",
      "ib commands --mutations",
      "ib commands --permission auth.page.vehicle",
      "ib commands --mutations | jq '.items[].command'",
    ],
  },
];
