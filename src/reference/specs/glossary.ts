// glossary specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { clearHint, clearNote, intParseErr, assessWriteFlags, needsReviewFlags, MAX_CONFIDENCE_PARSE_ERR, AI_CONFIDENCE_PARSE_ERR } from "./shared.js";

export const GLOSSARY_SPECS: CommandSpec[] = [
  // ─── glossary ────────────────────────────────────────────────────────────────
  {
    command: "ib glossary lookup",
    description: "Resolve a Finnish/colloquial term or synonym to its definition + related commands (DB-backed). Exit 5 if undefined — the miss is recorded for the groomer.",
    auth: "any",
    args: [{ name: "term", type: "string", required: true, description: "A word or synonym, e.g. pumppari" }],
    flags: [],
    outputShape: "single term: { term, synonyms[], definition, relatedCommands:[{command,summary}], relatedEntity } | batch (a,b,c): ListEnvelope<{ term, found, entry }>",
    notes: ["Comma-separated terms (a,b,c) run a batch lookup returning a ListEnvelope of {term,found,entry}; a single term keeps the single-entry shape."],
    errors: [
      { http: 404, exit: 5, meaning: "No entry for the term", remedy: "Try `ib glossary list --search <term>`; the miss is queued for definition" },
      { origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" },
    ],
    examples: ["ib glossary lookup pumppari", "ib glossary lookup betoniasema", "ib glossary lookup loma,saikku,pyhä"],
  },
  {
    command: "ib glossary list",
    description: "List glossary entries; --search filters by term/definition/synonym, --stalest orders least-recently-reviewed first.",
    auth: "any",
    args: [],
    flags: [
      { name: "search", type: "string", description: "Filter by substring" },
      { name: "stalest", type: "number", description: "Return up to N entries, stalest first" },
      { name: "domain", type: "string", description: "Filter to a domain (exact match)" },
      { name: "related", type: "string", description: "Filter to terms whose relatedCommands contain this substring" },
      { name: "terms-only", type: "boolean", description: "Return only {term, synonyms} per entry — the cheap INDEX view (strips definitions); use to discover which terms exist." },
      ...needsReviewFlags("term"),
    ],
    outputShape: "{ items:[{term,synonyms,definition,relatedCommands:[{command,summary}],relatedEntity,domain,lastReviewed,runs,aiConfidence,needsHumanReview}], count, truncated? }",
    notes: [
      "--terms-only is client-side: it strips each row to {term, synonyms} after the server-side filters apply. Use it instead of a full list to discover terms cheaply (the full list returns every definition).",
    ],
    errors: [
      intParseErr("--stalest", "pass a positive integer"),
      MAX_CONFIDENCE_PARSE_ERR,
      { origin: "client", exit: 2, meaning: "Not authenticated", remedy: "Run `ib auth login`" },
    ],
    examples: ["ib glossary list", "ib glossary list --search puomi", "ib glossary list --stalest 10", "ib glossary list --domain vacation", "ib glossary list --terms-only", "ib glossary list --needs-review"],
  },
  {
    command: "ib glossary misses",
    description: "Open lookup misses ranked by frequency — the groomer's queue of undefined terms (developer only).",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [{ name: "top", type: "number", description: "Return up to N" }],
    outputShape: "{ items:[{term,count,firstSeen,lastSeen,status}], count, truncated? }",
    errors: [
      intParseErr("--top", "pass a positive integer"),
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
    ],
    examples: ["ib glossary misses --top 20"],
  },
  {
    command: "ib glossary dismiss",
    description: "Dismiss an open lookup miss WITHOUT defining the term — for junk/test lookups (developer only). The term re-enters the queue if it is ever looked up again.",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "term", type: "string", required: true, description: "Missed term (as listed by `ib glossary misses`)" }],
    flags: [],
    outputShape: "{ term, dismissed: 1 }; or { dryRun: true, term, wouldDismiss: boolean } with --dry-run",
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { http: 404, exit: 5, meaning: "No OPEN miss for that term", remedy: "Check `ib glossary misses` for the exact term" },
    ],
    examples: [
      "ib glossary dismiss xa4 --reason junk",
      "ib glossary dismiss xa4 --dry-run",
    ],
  },
  {
    command: "ib glossary set",
    description: "Create/update a glossary entry (developer only). UPSERT: creates the term if absent, pass --update-only to require it already exists (404 otherwise). PARTIAL update: only the fields you pass change — omit a flag to KEEP its current value, pass an empty value to CLEAR it. " + clearNote("--synonyms") + " Auto-resolves a matching miss.",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "term", type: "string", required: true, description: "Canonical term" }],
    flags: [
      { name: "definition", type: "string", description: "One-paragraph definition (≤2000). Omit to keep current." },
      { name: "synonyms", type: "string", description: 'Comma-separated aliases incl. inflections. Omit to keep; ' + clearHint("--synonyms") + "." },
      { name: "related", type: "string", description: 'Comma-separated command paths, e.g. "ib person,ib vehicle driver board". Omit to keep; ' + clearHint("--related") + "." },
      { name: "entity", type: "string", description: "Related DB entity, e.g. Person / personId. Omit to keep." },
      { name: "domain", type: "string", description: "Domain grouping (e.g. vacation). Omit to keep." },
      { name: "update-only", type: "boolean", description: "Only update an existing term; do not create a new one (404 if absent)" },
      { name: "from-json", type: "string", description: "Read fields from a JSON object file (or - for stdin); flags override. Keys: definition, synonyms, relatedCommands, relatedEntity, domain, aiConfidence, needsHumanReview. Only keys present in the object are written (others kept, EXCEPT the two assessment fields — see notes)." },
      { name: "add-synonyms", type: "string", description: "Comma-separated synonyms to ADD to the existing list — no full resend. Excl. --synonyms." },
      { name: "remove-synonyms", type: "string", description: "Comma-separated synonyms to REMOVE by name (idempotent). Excl. --synonyms." },
      { name: "append-definition", type: "string", description: "Append a clause to the current definition (single-space join; re-appending identical text is a no-op). Excl. --definition." },
      ...assessWriteFlags("term"),
    ],
    outputShape: "{ term, synonyms, definition, relatedCommands, relatedEntity, domain, runs }",
    notes: [
      "PARTIAL (PATCH) semantics: an omitted flag is NOT sent, so the backend preserves the existing value — you can update just one field (e.g. only --synonyms) without re-sending the definition. To CLEAR a field pass an empty value: `--synonyms \"\"` empties the list, `--entity \"\"` blanks it. " + clearNote("--synonyms") + " To OVERWRITE, pass the new value.",
      "Requires the partial-aware backend (COALESCE save proc) deployed; against an older backend an omitted field is still overwritten to empty/null — re-send all fields (or use --from-json) until the backend is updated.",
      "--ai-confidence / --needs-human-review are NOT partial: the backend direct-assigns them, so any write that omits them RESETS the score to null and clears the parked flag (by design — a human edit re-opens the row for grooming). A grooming write must therefore carry aiConfidence EVERY time, via the flag or the --from-json key. Both are read from --from-json since fb#298; before that fix the JSON key was silently dropped and the score wiped.",
      "Append mode (--add-synonyms / --remove-synonyms / --append-definition) edits in place without re-sending the whole field — built for no-filesystem callers (MCP ib_exec, /api/cli/exec) that can't use --from-json. The merge runs server-side and the target term must already exist (404 otherwise). Deploy-gated: against an un-updated backend these flags no-op (the value is preserved, not corrupted).",
      "An append flag COMPOSES with plain overwrite flags for OTHER fields in the same call: `--definition \"new\" --add-synonyms \"x\"` overwrites the definition AND merges the synonym in one request. Only the same-field twin is rejected (exit 4): --definition⊥--append-definition and --synonyms⊥--add/remove-synonyms. Deploy-gated: an un-updated backend drops the plain field instead of composing — until it deploys, set OTHER fields in a separate call.",
    ],
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { http: 404, exit: 5, meaning: "Term not found (with --update-only)", remedy: "Omit --update-only to create the entry" },
      // Both 404s say "glossary term 'X' not found"; only the parenthetical
      // differs, so the append row matches on that and --update-only stays the
      // catch-all (fb#668).
      { http: 404, exit: 5, match: "append/add/remove requires an existing term", meaning: "append/add/remove on a non-existent term", remedy: "Create the term first (set --definition …); append requires an existing entry" },
      { http: 400, exit: 4, meaning: "definition >2000 chars (the message names the effective length; --append-definition reports the MERGED current+appended length)", remedy: "Shorten the definition" },
      { origin: "client", exit: 4, match: "--from-json", meaning: "--from-json file is not valid JSON or not readable", remedy: "Check the file path and contents" },
      AI_CONFIDENCE_PARSE_ERR,
    ],
    examples: ['ib glossary set valumassa --definition "Pumpattava betonimassa." --synonyms "massaa,valua" --related "ib keikka" --reason "groom"', 'ib glossary set puomi --synonyms "boom,nollakone,puomiton" --reason "add synonyms only"', 'ib glossary set pumppari --definition "Updated def." --update-only --reason "groom"', 'ib glossary set loma --from-json loma.json --reason "groom"', 'ib glossary set puomi --add-synonyms "nollakone" --reason "add one synonym"', 'ib glossary set tilaus --append-definition "Convention: UI says tilaus, code says keikka." --reason "append clause"'],
  },
  {
    command: "ib glossary import",
    description: "Bulk create/update glossary entries from a JSON array file (developer only). Avoids shell argv mangling of Finnish ä/ö.",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "server",
    args: [{ name: "file", type: "string", required: true, description: "JSON array file of {term, definition, synonyms?, relatedCommands?, relatedEntity?, domain?, aiConfidence?, needsHumanReview?} objects (or - for stdin)" }],
    flags: [
      { name: "update-only", type: "boolean", description: "Only update existing terms; never insert" },
    ],
    outputShape: "{ results: [{term, ok, error?}], ok, failed }",
    notes: [
      "Each entry must have a `term` field; entries missing it are counted as failed.",
      "Synonyms and relatedCommands may be arrays (arrays are accepted and converted to a comma list internally) or comma-separated strings.",
      "Avoids shell argv mangling of Finnish ä/ö — pass UTF-8 JSON instead of quoting on the command line.",
      "There is no --ai-confidence flag here, so a per-entry `aiConfidence` key is the ONLY way a bulk groom can carry its score. The backend resets that field on any write that omits it, so an entry without the key is stored unscored (and re-queued for grooming). Entry keys are honoured since fb#298 — before that fix import silently wiped the score of every term it touched.",
    ],
    errors: [
      { http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" },
      { origin: "client", exit: 4, meaning: "File is not valid JSON or root is not an array", remedy: "Check the file path and JSON syntax" },
    ],
    examples: ['ib glossary import terms.json --reason "bulk groom"', 'echo \'[{"term":"loma","definition":"Vapaapaiva"}]\' | ib glossary import - --reason "test"'],
  },
  {
    command: "ib glossary delete",
    description: "Delete a glossary entry (developer only).",
    tier: "developer",
    auth: "any",
    writeFlags: true,
    dryRunKind: "client",
    args: [{ name: "term", type: "string", required: true, description: "Canonical term" }],
    flags: [],
    outputShape:
      "{ deleted: 0|1 } — rows removed; or { dryRun: true, term, wouldDelete: <entry>|null } with --dry-run",
    errors: [{ http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" }],
    notes: [
      "--dry-run resolves CLIENT-SIDE: it previews the entry that WOULD be deleted (via the miss-free ?search= endpoint) and never issues the DELETE — safe even before the backend guard deploys (the backend DELETE route ignored X-Dry-Run before this fix, so a --dry-run silently destroyed the entry).",
    ],
    examples: [
      "ib glossary delete obsolete-term --reason cleanup",
      "ib glossary delete obsolete-term --dry-run",
    ],
  },
  {
    command: "ib glossary lint",
    description: "Audit entries: dead relatedCommands, near-duplicate terms, empty fields (developer only).",
    tier: "developer",
    auth: "any",
    args: [],
    flags: [
      { name: "strict", type: "boolean", description: "Exit 1 if any warn-level finding exists (for CI)" },
      { name: "suggest-related", type: "boolean", description: "Also emit stale-related suggestions: specs mentioning a term/synonym/entity but not yet linked (info-level)" },
    ],
    outputShape: "ListEnvelope<{ term, issue: 'dead-related'|'near-duplicate'|'empty-definition'|'no-anchor'|'synonym-collision'|'stale-related', detail, severity }>",
    errors: [{ http: 403, exit: 3, meaning: "Not a developer", remedy: "Developer access required" }],
    notes: [
      "--suggest-related is a grooming aid (fb#110): it proposes command paths whose path/flags/description mention the term (whole-word, >=4 chars), ranked path>flag>description, capped 6/term — review before adding, false positives are possible.",
    ],
    examples: ["ib glossary lint", "ib glossary lint --suggest-related"],
  },
];
