/**
 * `ib changelog` — development changelog entry management.
 *
 * Entries are the authoritative source for the monthly report.
 * Each entry records a feature, improvement, bugfix, or docs change with
 * metadata (type, area, files, commit SHAs, linked cliFeedback id, etc.).
 *
 * Commands:
 *   add      POST   /api/changelog   (developer-only; --dry-run is server-side via X-Dry-Run)
 *   list     GET    /api/changelog   (filtered; developer-only)
 *   get      GET    /api/changelog/:id
 *   update   PUT    /api/changelog/:id  (developer-only)
 *   delete   DELETE /api/changelog/:id  (developer-only; soft-delete; --dry-run is client-side)
 *   report   GET    /api/changelog/report?month=&format=  (developer-only)
 *
 * All specs carry `tier: "developer"` — the whole changelog domain is hidden
 * from non-developer / tokenless callers in discovery (see src/tier.ts).
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { cappedListEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import {
  CHANGELOG_LIST_CAP,
  CHANGELOG_LIST_DEFAULT,
  warnIfLimitCapped,
} from "../../api/listCaps.js";
import type { CommandSpec } from "../../output/help.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { readJsonInput } from "../../api/parseBody.js";
import { writeJson, failWith, failUsage, failValidation, warnNote } from "../../output/json.js";
import type { FlagProblem } from "../../output/validationEnvelope.js";
import { resolveDate } from "../../dates.js";
import { parseRefId, assertEnum, intFlag, intCsvFlag, cappedInt } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { normalizeRepoCsv } from "./repos.js";
import { jsonAction, guarded } from "../_shared/action.js";
import { explicitFlags, foldAliases, warnIfShellMangled } from "../_shared/flags.js";
import {
  type FromJsonConfig,
  payloadKeyMap as sharedPayloadKeyMap,
  normalizeFromJson,
  applyFromJson as sharedApplyFromJson,
} from "../_shared/fromJson.js";
import { qs } from "../../api/query.js";

type Row = Record<string, unknown>;

const TYPES = ["feature", "improvement", "bugfix", "docs"];
const AREAS = ["frontend", "backend", "cli", "database", "cicd", "workspace"];
const BUMP_LEVELS = ["none", "patch", "minor", "major"];
const LANGUAGES = ["fi", "en"]; // devChangelog.language is CHAR(2) NOT NULL DEFAULT 'en'
const SOURCES = ["human", "routine"];
/** Shared by the `add` and `update` spec notes (fb#1294) — one string, two renders. */
const SERVER_ENUM_NOTE =
  "--type/--area are SERVER-validated (fb#1294): a `must be one of` naming only OLD values means the API predates this CLI's enum, not that the value is wrong — check `ib version`.";

// COORDINATED_REPOS / normalizeRepoCsv: see ./repos.ts (mirror of the backend
// repo model). Step 0 bumps coordinated repos independently from the max
// --bump-level across the unreleased entries naming them; a --repo whose CSV
// resolves to NO known repo at all fail-safe-bumps EVERY coordinated repo
// (unless --bump-level none). The standalone lane (betonicli, @ibetoni/*)
// versions separately via `npm run final` — target it with --bump-level none.
//
// The lane is decided per-token by computeReleasePlan, NOT by coordinated-set
// membership: `recognizedAny` (canonical.length > 0) short-circuits before the
// fail-safe, so a recognized-but-non-coordinated repo bumps nothing whatever
// --bump-level says. Keep that distinction visible in the help text — collapsing
// it into "unrecognized" is what made fb#354 mis-read a safe call as dangerous.
// The old wording said "an UNRECOGNIZED value fail-safe-bumps ALL coordinated
// repos … for the standalone lane also pass --bump-level none", which reads as
// "not in the coordinated list" and so describes `--repo betonicli` — a value
// that is recognized, bumps nothing, and needs no --bump-level none. A reporter
// believed a routine standalone-lane entry had armed a five-repo bump and filed
// it (feedback #354). Spell the three tiers out, since only the third is armed.
//
// fb#1351 correction: tier (3) as originally written ("a value resolving to NO
// known repo … fail-safe-bumps EVERY coordinated repo") is itself imprecise for
// a NON-BLANK token — canonicalizeRepo (puminet5api modules/changelog/changelog.js)
// hard-rejects any unresolved, non-blank token at add-time (400 / exit 4), so it
// can never reach computeReleasePlan's Step 0 fail-safe at all. That fail-safe
// only ever fires for a BLANK/omitted --repo on an already-persisted row — a
// distinct case from "a value that resolves to nothing." REPO_FLAG_DESC below
// was reworded accordingly (2026-09) — keep the two in sync.
//
// Lead with "(CSV)" like the sibling --files/--sha/--commit descriptions do
// (fb#408): --repo has always accepted a CSV (csvFields below; the backend
// canonicalizes per token and computeReleasePlan bumps EVERY coordinated token),
// but the singular opening made a reporter file a cross-lane change under one
// repo and demote the other to a --files path, losing the attribution. Cross-lane
// is not an edge case — the versioning model HAS two lanes, and any CLI change
// needing a backend route touches both.
const REPO_FLAG_DESC =
  "Repo(s) this entry ships in (CSV); a cross-lane change names BOTH, e.g. `--repo \"puminet5api,betonicli\"`. THREE outcomes: (1) coordinated — puminet4|puminet5api|puminet7-functions-app|betonijerry|workspace — bumped independently next deploy from the max --bump-level naming it; (2) standalone — betonicli, @ibetoni/*, dbo.*, ibetoni-site, bsg2, betonipumppu — no app bump (version via `npm run final`); (3) any OTHER non-blank value is REJECTED (400/exit 4) at add-time, never reaching a deploy fail-safe. BLANK/omitted --repo differs: it IS accepted, and deploy Step 0 fail-safe-bumps every coordinated repo unless --bump-level none.";
const AREA_FLAG_DESC =
  "Technical layer: frontend|backend|cli|database|cicd|workspace (repo granularity goes in --repo, not here). This is different from `ib dev feedback --scope`, which names the product surface; ops/jerry/security are scopes, not areas.";
// Scope-shaped values agents predictably pass to --area (`ib dev feedback
// --scope` accepts these). The remedy string is built from the key at the call
// site. No `jerry` entry: AREA_REPO_REMEDIES below also carries `jerry` and
// wins the remedy ternary, so a scope remedy for it would be unreachable.
const AREA_SCOPE_VALUES = new Set(["app", "bsg2", "impeccable", "ops", "other", "security"]);
// Named once and used by both the Commander options and the specs, so the
// "these two --severity flags are different scales" warning cannot survive on
// one surface and go missing on the other (feedback #359).
const SEVERITY_FLAG_DESC =
  "Bug severity — Kriittinen|Korkea|Normaali|Matala (an URGENCY ladder; English critical/high/normal/low and the feedback impact words major/minor/cosmetic are accepted and mapped). ⚠ NOT interchangeable with `ib dev feedback --severity` (critical|major|minor|cosmetic), which is an IMPACT ladder with no counterpart for Normaali.";

// The three fragments `add` and `update` state IDENTICALLY. Hoisted for the same
// reason as SEVERITY_FLAG_DESC above: a rule that lives in two string literals
// drifts. It already did — fb#633 had to hand-edit both `outputShape`s to add
// `resolutionPreserved`, and the two copies ended up with different tails.
// Each leaf still appends its own closing sentence after these.
// Parameterized (fb#880 review): --take-resolve exists ONLY on `add`, so the
// shared from-json prose must not advertise it on `update` (which registers no
// such flag — following update's help there yields an unknown-option error).
const fromJsonNonPayloadDesc = (hasTakeResolve: boolean): string =>
  "NOT every flag has a JSON twin (fb#631): the BEHAVIOURAL modifiers — --no-resolve" +
  (hasTakeResolve ? " / --take-resolve" : "") +
  " (link role) and the write-safety trio --dry-run / --reason / --idempotency-key — stay on the command line, and `noResolve`/`resolve`" +
  (hasTakeResolve ? "/`takeResolve`" : "") +
  " in the file exit 4.";
const FEEDBACK_LINKS_SHAPE_DESC =
  "One entry per --feedback id, in the order given. `role` is `resolves` or `references`. `relinkedFrom` carries the entry a `resolves` link took the row from; `linkKeptBy` is its mirror when a resolved row's link was LEFT in place (--no-resolve, or `add`'s fb#880 default cross-reference); `feedbackStatus` appears only when the link did NOT close the row; `feedbackLinked: false` means that id does not exist";
const RESOLUTION_PRESERVED_SHAPE_DESC =
  "`resolutionPreserved` carries the row's existing hand-written resolution note when the link advanced the status to `applied` but KEPT that note (fb#633) — status and note may now contradict each other, so re-read the row.";
const SINGLE_LINK_MIRROR_DESC =
  "For a SINGLE id these keys are also mirrored to the top level, for compatibility with CLI builds predating fb#576. Each emits a one-line note on stderr, prefixed with its fb# id.";

/**
 * Repo-shaped values agents predictably pass to --area (feedback #212 —
 * `ib feedback --scope` accepts "jerry", so `--area jerry` is a natural first
 * reach when the work is in a specific repo). Maps the mistaken value to the
 * --repo it almost certainly meant, so the validation problem can carry a
 * targeted remedy instead of only the allowed-values list.
 */
const AREA_REPO_REMEDIES: Record<string, string> = {
  jerry: "betonijerry",
  betonijerry: "betonijerry",
  puminet4: "puminet4",
  puminet5api: "puminet5api",
  "puminet7-functions-app": "puminet7-functions-app",
  betonicli: "betonicli",
};

/**
 * Normalize a Sentry issue reference: accept a bare short id (e.g. PUMINET5API-1A2)
 * or extract one from a pasted URL/string; otherwise trim and cap at 64 chars to fit
 * the devChangelog.sentryIssue column. Store-only — never sent to Sentry.
 */
export function normalizeSentryRef(raw: string): string {
  const trimmed = raw.trim();
  // Greedy on trailing hyphen groups (fb#1021): a Sentry short id is
  // <PROJECT-SLUG>-<counter> and the slug itself may contain hyphens (e.g.
  // NODE-EXPRESS-7G), so a non-greedy single "-GROUP" match truncated it.
  const m = trimmed.match(/[A-Z0-9]{2,}(?:-[A-Z0-9]+)+/);
  return (m ? m[0] : trimmed).slice(0, 64);
}

export interface ChangelogAddBody {
  type: string;
  area: string;
  title: string;
  description: string;
  entryDate: string;
  benefits?: string;
  impact?: string;
  status?: string;
  severity?: string;
  files?: string;
  repo?: string;
  commitShas?: string;
  versionTag?: string;
  bumpLevel?: string;
  /** fb#576: a single --feedback id, OR a CSV of several, one link per id. */
  feedbackId?: number | number[];
  /** Not a column: the backend reads it as a link option. Sent only as `false`, by --no-resolve (fb#441). */
  resolveFeedback?: boolean;
  /** Not a column either: ids whose link to THIS entry is removed (--unlink, fb#585). `update` only. */
  unlinkFeedbackId?: number | number[];
  sentryIssue?: string;
  source?: string;
  language?: string;
}

/**
 * POST /api/changelog. --dry-run is SERVER-side: the request carries X-Dry-Run
 * and the backend validates the payload (bad enum/date/missing fields still 400)
 * then echoes `{ dryRun, wouldCreate, validation }` without inserting.
 */
export async function runChangelogAdd(
  client: ApiClient,
  body: ChangelogAddBody,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>("/api/changelog", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * fb#880: the subset of `ids` whose cliFeedback row is ALREADY resolved by a
 * changelog entry (resolvedByChangelogId set). `add --feedback` used to
 * silently TAKE the resolves-link from that original fix entry in this case —
 * a trap, because a follow-up entry to a closed row is far more common than an
 * intentional re-resolve. The add action pre-checks with this and, if ANY id
 * is already resolved, sends resolveFeedback:false for the WHOLE request —
 * resolveFeedback is per-request, not per-id, so every id in the same call
 * (including still-open ones) links as role `references` and nothing advances,
 * unless --take-resolve re-owns the link.
 *
 * Fail-open per id (a pre-check must never block the add): a GET that errors
 * simply does not mark its id, and the historical take-the-link behaviour —
 * with its `relinkedFrom` stderr note — remains the backstop for it.
 */
export async function findAlreadyResolvedFeedback(
  client: ApiClient,
  ids: number[]
): Promise<Array<{ feedbackId: number; resolvedByChangelogId: number }>> {
  const out: Array<{ feedbackId: number; resolvedByChangelogId: number }> = [];
  for (const id of ids) {
    let row: Record<string, unknown> | undefined;
    try {
      row = await client.get<Record<string, unknown>>(`/api/feedback/${id}`);
    } catch {
      continue;
    }
    const resolver = row?.resolvedByChangelogId;
    if (typeof resolver === "number") out.push({ feedbackId: id, resolvedByChangelogId: resolver });
  }
  return out;
}

export async function runChangelogList(client: ApiClient, opts: Record<string, string | number | boolean | undefined>): Promise<ListEnvelope<Row>> {
  if (typeof opts.sentry === "string") opts.sentry = normalizeSentryRef(opts.sentry);
  // --feedback maps to the backend's `feedbackId` filter; --search/--status are
  // substring LIKE filters (the controller passes req.query straight to
  // listEntries). qs() drops the undefined ones.
  const p: Record<string, string | number | boolean | undefined> = {
    month: opts.month, type: opts.type, area: opts.area, repo: opts.repo,
    feedbackId: opts.feedback, sentryIssue: opts.sentry, source: opts.source,
    search: opts.search, status: opts.status, limit: opts.limit, offset: opts.offset,
  };
  if (opts.hasFeedback) p.hasFeedback = "1";
  if (opts.hasSentry) p.hasSentry = "1";
  const rows = await client.get<Row[]>(`/api/changelog${qs(p)}`);
  warnIfLimitCapped(opts.limit, CHANGELOG_LIST_CAP, "ib dev changelog list");
  return cappedListEnvelope<Row>(rows, {
    requested: opts.limit as number | undefined,
    serverCap: CHANGELOG_LIST_CAP,
    serverDefault: CHANGELOG_LIST_DEFAULT,
    meta: client.getLastListMeta?.(),
  });
}

export async function runChangelogGet(
  client: ApiClient,
  id: number
): Promise<Row> {
  return client.get<Row>(`/api/changelog/${id}`);
}

export async function runChangelogUpdate(
  client: ApiClient,
  id: number,
  patch: Partial<ChangelogAddBody>,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldUpdate: { id, patch } };
  return client.put<unknown>(`/api/changelog/${id}`, patch, {
    headers: writeFlagsToHeaders(flags),
  });
}

/**
 * DELETE /api/changelog/:id (backend soft-deletes: sets isDeleted=1). The route
 * has no X-Dry-Run guard, so --dry-run resolves CLIENT-side (echoes wouldDelete,
 * issues no DELETE) — mirrors runChangelogUpdate.
 */
export async function runChangelogDelete(
  client: ApiClient,
  id: number,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldDelete: { id } };
  return client.delete<unknown>(`/api/changelog/${id}`, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runChangelogReport(
  client: ApiClient,
  month: string,
  format: string
): Promise<Row> {
  return client.get<Row>(`/api/changelog/report${qs({ month, format })}`);
}

export async function runChangelogPending(client: ApiClient): Promise<unknown> {
  return client.get<unknown>("/api/changelog/pending");
}

export async function runChangelogRelease(
  client: ApiClient,
  versionTag: string,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    "/api/changelog/release",
    { versionTag },
    { headers: writeFlagsToHeaders(flags) }
  );
}

export async function runChangelogReleaseMap(
  client: ApiClient,
  map: Array<{ changelogId: number; versionTag: string }>,
  flags: WriteFlags
): Promise<unknown> {
  return client.post<unknown>(
    "/api/changelog/release",
    { map },
    { headers: writeFlagsToHeaders(flags) }
  );
}

/**
 * Validate the enum flags, reporting ALL bad values at once via the prescriptive
 * validation envelope (feedback #204): each problem carries its allowed values
 * (and, for --type, the accepted synonyms), plus a copy-paste sample resolved
 * from the command's spec — so a caller fixes every enum in one re-run instead
 * of hitting them one at a time. `commandPath` selects which spec (add/update)
 * supplies the sample. (--language is validated separately in normalizeLanguage.)
 */
export function validateEnums(
  type?: string,
  area?: string,
  bumpLevel?: string,
  source?: string,
  severity?: string,
  commandPath = "ib dev changelog add"
): void {
  const problems: FlagProblem[] = [];
  if (severity !== undefined && !SEVERITIES.includes(severity))
    problems.push({
      flag: "--severity",
      issue: "invalid",
      got: severity,
      allowed: SEVERITIES,
      synonyms: SEVERITY_SYNONYMS,
      remedy:
        "an URGENCY ladder — NOT `ib dev feedback --severity`'s impact scale (critical|major|minor|cosmetic); English urgency words and the impact words are accepted and mapped",
    });
  if (type !== undefined && !TYPES.includes(type))
    problems.push({ flag: "--type", issue: "invalid", got: type, allowed: TYPES, synonyms: TYPE_SYNONYMS });
  if (area !== undefined && !AREAS.includes(area)) {
    const lower = area.toLowerCase();
    const repo = AREA_REPO_REMEDIES[lower];
    problems.push({
      flag: "--area",
      issue: "invalid",
      got: area,
      allowed: AREAS,
      ...(repo
        ? {
            remedy: `--area is the technical layer, not the repo — pass --repo ${repo} and pick the layer from the allowed values`,
          }
        : AREA_SCOPE_VALUES.has(lower)
          ? { remedy: `use --scope ${lower} when filing feedback; --area accepts technical layers only` }
        : {}),
    });
  }
  if (bumpLevel !== undefined && !BUMP_LEVELS.includes(bumpLevel))
    problems.push({ flag: "--bump-level", issue: "invalid", got: bumpLevel, allowed: BUMP_LEVELS });
  if (source !== undefined && !SOURCES.includes(source))
    problems.push({ flag: "--source", issue: "invalid", got: source, allowed: SOURCES });
  if (problems.length)
    failValidation(commandPath, problems, {
      spec: CHANGELOG_SPECS.find((s) => s.command === commandPath),
    });
}

/**
 * Bounded free-text flags → their devChangelog column width (from
 * `ib dev schema table devChangelog`). An over-length value otherwise reaches
 * SQL and surfaces as a raw 500 ("String or binary data would be truncated",
 * feedback #206) instead of a clean client-side validation error. Keyed by the
 * CLI FLAG name (what the caller typed), so `--sha`→commitShas(500) and
 * `--vtag`→versionTag(200). description/benefits/files are nvarchar(max)
 * (unbounded, absent here); --sentry is pre-capped by normalizeSentryRef.
 */
export const FIELD_MAX_LENGTHS: Record<string, number> = {
  title: 300,
  impact: 500,
  status: 30,
  severity: 20,
  repo: 200,
  sha: 500,
  vtag: 200,
};

/**
 * Stamp each bounded flag's cap onto its own spec description (feedback #330).
 *
 * The caps were documented ONLY in a trailing NOTES line, so a caller composing
 * a payload — especially a `--from-json` file, whose key list repeats the field
 * names without limits — writes an over-length value, gets rejected, trims by
 * estimate, and can be rejected again. Derived from {@link FIELD_MAX_LENGTHS}
 * so the help text can never drift from the validator that enforces it.
 */
function withMaxLengths(flags: CommandSpec["flags"]): CommandSpec["flags"] {
  return (flags ?? []).map((f) => {
    const cap = FIELD_MAX_LENGTHS[f.name];
    return cap ? { ...f, description: `${f.description} (max ${cap} chars)` } : f;
  });
}

/**
 * Reject over-length free-text flags BEFORE POSTing so they exit 4 (validation)
 * naming each flag + its cap + the actual length, instead of the backend 500ing
 * on "String or binary data would be truncated" (feedback #206). Every offending
 * flag is reported together (aggregated) so the caller fixes them in one re-run.
 * Shared by `add` and `update` (identical flag names). Exits 4; returns void.
 *
 * Uses `failUsage` (NOT bare `failWith`) deliberately: this message already IS
 * the full remedy, and a hintless exit-4 would inherit the command's first
 * client ERRORS row — on `add` that is the argv-mangling row, so a caller who
 * was ALREADY using --from-json got told to use --from-json (feedback #305).
 * The positive hint states the per-flag overflow and explicitly rules that
 * remedy out. Keep the hint; reverting to `failWith` re-opens the dead end.
 */
export function validateFieldLengths(o: Record<string, unknown>): void {
  const over: string[] = [];
  const trims: string[] = [];
  for (const [flag, cap] of Object.entries(FIELD_MAX_LENGTHS)) {
    const v = o[flag];
    if (typeof v === "string" && v.length > cap) {
      over.push(`--${flag} is ${v.length} chars (max ${cap})`);
      trims.push(`--${flag} by ${v.length - cap}`);
    }
  }
  if (over.length)
    failUsage(
      `value too long — ${over.join("; ")}; shorten to fit the devChangelog column`,
      `trim ${trims.join(", ")} chars — a column-width limit, not shell/argv mangling, so --from-json does not help`
    );
}

/**
 * Resolve the entry description from the positional, the --description alias,
 * the --summary alias, OR the --body alias (mirrors `ib dev feedback create` —
 * feedback #172/#205/#278; "summary" and "body" are the words an AI reaches for
 * naturally for the entry text, --body being the gh/git convention and already
 * this CLI's name for a free-text body on `message chat send`). All four are
 * equivalent; exactly one value is required, and if several are given they must
 * agree. Exits 4 on conflict or absence.
 */
export function resolveChangelogDescription(
  positional?: string,
  flag?: string,
  summary?: string,
  body?: string
): string {
  const description = foldAliases(
    [positional, flag, summary, body],
    "Provide the description once — via the positional, --description, --summary, or --body; if several are given they must match"
  );
  // On the `add` path requireAddFields gates this first (richer envelope with a
  // per-flag remedy + sample), so this terse fallback fires only for direct
  // callers/tests — do not try to keep the two messages in sync.
  if (!description) failWith("--description (or --summary/--body, or a positional description) is required", 4);
  return description;
}

/** CSV `--files` → the stored JSON array string. Shared by `add` and `update`. */
function filesToJson(csv: string): string {
  return JSON.stringify(csv.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Resolve --sha from itself or its --commit alias (feedback #210 — commit SHAs
 * are near-universally called "commit", so first tries reach for --commit).
 * Both may be given only when they agree. Shared by `add` and `update`; fold in
 * BEFORE validateFieldLengths so the 500-char sha cap applies to the alias too.
 */
export function resolveShaAlias(sha?: string, commit?: string): string | undefined {
  if (sha !== undefined && commit !== undefined && sha.trim() !== commit.trim())
    failWith("--commit is an alias for --sha — pass one, or identical values", 4);
  return sha ?? commit;
}

/**
 * Conventional-commit synonyms for --type. Commit messages in this codebase use
 * `fix:` / `feat:`, so agents and devs repeatedly pass those to `changelog add`
 * (feedback #188). Map them to the canonical devChangelog enum before validation.
 */
const TYPE_SYNONYMS: Record<string, string> = { fix: "bugfix", feat: "feature" };

/**
 * Trim + lowercase --type and resolve a conventional-commit synonym
 * (`fix`→`bugfix`, `feat`→`feature`). Unknown values pass through unchanged for
 * validateEnums to reject; undefined passes through as undefined.
 */
export function normalizeType(type?: string): string | undefined {
  if (type === undefined) return undefined;
  const v = type.trim().toLowerCase();
  return TYPE_SYNONYMS[v] ?? v;
}

/**
 * Trim + lowercase the enum flags that have no synonym map of their own:
 * --area, --bump-level, --source (fb#842).
 *
 * `--type Fix` and `--severity High` have always worked, because their synonym
 * lookup lowercases first — so on the SAME command `--area Workspace` failing on
 * casing alone is an inconsistency between sibling flags, not a rule. The
 * validator already lowercases --area to pick a remedy hint
 * (AREA_REPO_REMEDIES[area.toLowerCase()]), i.e. it lowercases for the error
 * message but not for the match, which is the tell.
 *
 * Unknown values still pass through unchanged for {@link validateEnums} to
 * reject with the structured problems[] envelope; undefined stays undefined.
 * Lowercasing is safe for all three: every accepted value is already lowercase.
 */
export function normalizeEnumFlag(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  return v === "" ? undefined : v;
}

/**
 * The canonical `--severity` vocabulary — an URGENCY ladder, in Finnish, because
 * that is what the ~90 non-null rows in `devChangelog` already hold.
 *
 * Deliberately NOT the same ladder as `ib dev feedback --severity`
 * (critical|major|minor|cosmetic), which measures IMPACT: `Normaali` has no
 * counterpart there at all, so a value cannot be carried between the two
 * commands by lookup — it has to be re-judged (feedback #359).
 */
const SEVERITIES = ["Kriittinen", "Korkea", "Normaali", "Matala"];

/**
 * Accepted spellings → the canonical Finnish value.
 *
 * Covers the caller's own casing, the English urgency words, and the sibling
 * `feedback --severity` impact enum, which is the vocabulary an agent is most
 * likely to be holding: writing up one fix touches both commands, and guessing
 * wrong on the second cost a round-trip every time (feedback #359 — `Korkea`
 * was carried across as `normal` and rejected). Exactly the forgiveness
 * {@link TYPE_SYNONYMS} already grants `--type` on this same command.
 *
 * `major`→Korkea and `minor`/`cosmetic`→Matala are the honest 4→4 mapping of
 * the impact ladder onto the urgency one; `normal` has no impact-side source
 * and is reachable only from the English urgency word.
 */
const SEVERITY_SYNONYMS: Record<string, string> = {
  kriittinen: "Kriittinen", critical: "Kriittinen", blocker: "Kriittinen",
  korkea: "Korkea", high: "Korkea", major: "Korkea",
  normaali: "Normaali", normal: "Normaali", medium: "Normaali", moderate: "Normaali",
  matala: "Matala", low: "Matala", minor: "Matala", cosmetic: "Matala",
};

/**
 * Normalize --severity to a canonical Finnish value, or undefined when not
 * passed. An UNKNOWN value passes through unchanged for {@link validateEnums}
 * to reject — same split as {@link normalizeType}, so `--severity nonsense`
 * and `--type nonsense` return the same structured problems[] envelope
 * (allowed + synonyms machine fields) instead of two different error shapes.
 *
 * This flag used to be unvalidated free text capped at 20 chars, so a typo — or
 * an English value carried over from `ib dev feedback` — was accepted SILENTLY
 * and persisted into the permanent record the monthly report is generated from.
 * The command with the weaker guarantee was the one whose values were harder to
 * guess (feedback #359). Safe to tighten: the last 400 entries are 100% clean
 * Finnish (Normaali 44 · Korkea 33 · Matala 13 · Kriittinen 1), so validation
 * rejects nothing that is actually in use.
 */
export function normalizeSeverity(severity?: string): string | undefined {
  if (severity === undefined) return undefined;
  const v = severity.trim();
  if (!v) return undefined;
  return SEVERITY_SYNONYMS[v.toLowerCase()] ?? v;
}

/**
 * Normalize the five enum-ish flags in place — shared by `add` and `update`.
 * Guarded assignments serve both: every normalizer maps undefined → undefined,
 * and nothing downstream iterates the object's keys (requireAddFields,
 * validateEnums, validateFieldLengths and the body/patch builds all read named
 * keys and test !== undefined), so leaving an absent key absent is equivalent
 * to assigning it undefined on the `add` path while staying a correct partial
 * patch on the `update` path.
 */
function normalizeChangelogEnums(o: Record<string, string | undefined>): void {
  if (o.type !== undefined) o.type = normalizeType(o.type)!;
  if (o.severity !== undefined) o.severity = normalizeSeverity(o.severity)!;
  if (o.area !== undefined) o.area = normalizeEnumFlag(o.area)!;
  if (o.bumpLevel !== undefined) o.bumpLevel = normalizeEnumFlag(o.bumpLevel)!;
  if (o.source !== undefined) o.source = normalizeEnumFlag(o.source)!;
}

/** Normalize --language to a validated lowercase fi|en, or undefined when not passed. Exits 4 on a bad code. */
export function normalizeLanguage(lang?: string): string | undefined {
  if (lang === undefined) return undefined;
  const v = lang.trim().toLowerCase();
  assertEnum(v, LANGUAGES, "--language");
  return v;
}

// ─── --from-json (fb#300) ────────────────────────────────────────────────────
// A changelog description is long-form prose ABOUT code, so it is the text most
// likely to contain double quotes (quoted identifiers, JSON fragments, error
// strings) — and Windows PowerShell splits a native argument on those inner
// quotes, so the CLI saw N positionals and exited 4 ("too many arguments for
// 'add'"). The entry documenting fb#298/#299 hit exactly that and only filed
// after every quote was stripped from the prose, silently degrading the
// permanent record the monthly report is generated from. --from-json <file|->
// sidesteps argv entirely, mirroring `ib dev feedback create` (fb#299).
//
// The pipeline itself (key-map derivation, unknown-key/wrong-type rejection,
// explicit>JSON>default precedence) is the SHARED implementation in
// _shared/fromJson.ts — this file only supplies changelog's config and keeps
// its historical export names as thin wrappers.

/**
 * The five column names `ib dev changelog list` emits that differ from the
 * write flags, so a read row can be edited and posted straight back
 * (feedback #357) — the emitted shape is untouched, and the flag names stay
 * canonical. Also used (reversed) by {@link warnIfPatchIgnored} to name the
 * flag for a deploy-gated column the backend ignored.
 *
 * `feedbackLinks` (fb#576) is deliberately NOT here. It is a read-only OUTPUT
 * field — a list of `{feedbackId, role}` link records, not a flag value — in the
 * same class as changelogId/personId/isDeleted/createdAt/updatedAt, which the
 * pipeline also rejects as unknown keys. Mapping it onto `--feedback` would drop
 * the roles and re-post every id as a resolving link, so round-tripping a row
 * carrying a `references` link would silently STEAL that link from the entry
 * that shipped the fix — the exact fb#548 failure this junction exists to
 * remove. A loud exit 4 naming the key is the right answer. (An earlier
 * `feedbackIds` entry here named a key nothing emits and was simply dead.)
 */
const READ_SHAPE_KEY_ALIASES: Record<string, string> = {
  commitShas: "sha",
  versionTag: "vtag",
  feedbackId: "feedback",
  sentryIssue: "sentry",
  entryDate: "date",
};

/**
 * Changelog's `--from-json` config (see {@link FromJsonConfig}):
 * - nonPayload: the JSON source itself, the write-safety trio, and help;
 * - readShapeAliases: {@link READ_SHAPE_KEY_ALIASES};
 * - numericFields/csvFields: how Commander parses the matching flags.
 */
const CHANGELOG_FROM_JSON: FromJsonConfig = {
  // `resolve` is --no-resolve's Commander attribute name, so registering that flag
  // added it to the derived accepted-key list for free — and then it was unusable
  // in both spellings: `"resolve": false` exited 4 ("must be a string"), and
  // `"resolve": "false"` was accepted and SILENTLY DROPPED, force-applying the row
  // anyway. That is the fb#298 silent-drop class this whole pipeline exists to
  // prevent, so ADVERTISING the key is worse than omitting it: excluded here, it is
  // loudly rejected as unknown (fb#541). No capability is lost — --no-resolve is a
  // valueless flag, so it has no shell-quoting problem and every caller that needs
  // --from-json for its prose can still pass --no-resolve on argv alongside it.
  nonPayload: new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help", "resolve", "takeResolve"]),
  readShapeAliases: READ_SHAPE_KEY_ALIASES,
  numericFields: new Set([]),
  // fb#576: --feedback is now CSV (a single id or several); csvFields is the
  // shape the shared --from-json pipeline uses for a flag whose JSON form is a
  // string or an array of strings — see normalizeFeedbackIds below for why that
  // still needs a second parse pass once it lands on `o.feedback`.
  csvFields: new Set(["files", "repo", "sha", "commit", "feedback"]),
  // Scoped opt-in (fb#576 fix round 1): ONLY --feedback also accepts a bare JSON
  // number (templating off a read row's numeric feedbackId column). files/repo/
  // sha/commit stay string-or-array-only — a numeric --repo/--sha/--files/--commit
  // is a real caller mistake and must still exit 4, not silently coerce.
  numericTolerantCsvFields: new Set(["feedback"]),
};

/** Changelog's key map — the shared {@link sharedPayloadKeyMap} with {@link CHANGELOG_FROM_JSON}. */
export function payloadKeyMap(cmd: Command): Map<string, string> {
  return sharedPayloadKeyMap(cmd, CHANGELOG_FROM_JSON);
}

/** Changelog's normalizer — the shared {@link normalizeFromJson} with {@link CHANGELOG_FROM_JSON}. */
export function normalizeChangelogJson(
  json: Record<string, unknown>,
  keys: Map<string, string>
): Record<string, unknown> {
  return normalizeFromJson(json, keys, CHANGELOG_FROM_JSON);
}

// explicitFlags moved to _shared/flags.ts (feedback adopted it too); the merge
// rung is the shared mergeFromJsonInput. Both re-exported under their historical
// names for existing importers.
export { explicitFlags };
export { mergeFromJsonInput as mergeChangelogInput } from "../_shared/fromJson.js";

/** Changelog's composed apply — the shared {@link sharedApplyFromJson} with {@link CHANGELOG_FROM_JSON}. */
export function applyFromJson(cmd: Command, o: Record<string, unknown>): void {
  sharedApplyFromJson(cmd, o, CHANGELOG_FROM_JSON);
}

/**
 * Enforce `add`'s required fields AFTER the --from-json merge.
 *
 * --type/--area/--title are declared as plain options rather than
 * `.requiredOption` because Commander enforces a required option BEFORE any
 * action runs — which would make `add --from-json entry.json` fail no matter what
 * the file contains. They are enforced here instead, aggregated with the
 * description into ONE prescriptive envelope: the same shape the parser layer
 * emits (fb#204), carrying every missing flag, its allowed values, and a
 * copy-paste sample from the spec.
 */
export function requireAddFields(description: string | undefined, o: Record<string, unknown>): void {
  const has = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  const problems: FlagProblem[] = [];
  for (const f of ["type", "area", "title"] as const)
    if (!has(o[f])) problems.push({ flag: `--${f}`, issue: "missing" });
  // The `sample` on the envelope is the full template; the remedy covers the
  // alternate spellings the sample cannot show (fb#851 — hosted/MCP callers
  // compose from the rejection alone, without CLAUDE.md priming).
  if (![description, o.description, o.summary, o.body].some(has))
    problems.push({
      flag: "--description",
      issue: "missing",
      remedy:
        "provide the entry text once: positionally, or as --description (aliases: --summary, --body) — copy the envelope's `sample` and fill in real values",
    });
  if (problems.length)
    failValidation("ib dev changelog add", problems, {
      spec: CHANGELOG_SPECS.find((s) => s.command === "ib dev changelog add"),
    });
}

/**
 * Fields the UPDATE route only learned to accept in a later backend version
 * (feedback #303). Against an older deployment the PUT succeeds and echoes the
 * row UNCHANGED — the exact silent-drop this feedback was filed about — so the
 * absence of an error is not evidence the edit landed.
 */
const DEPLOY_GATED_PATCH_FIELDS = ["bumpLevel", "feedbackId", "sentryIssue"] as const;

/**
 * Warn on stderr when the backend echoed back something other than what we sent
 * for a deploy-gated field. The route returns the updated row, so a mismatch
 * means that column is not in the deployed allowlist. stderr only — the stdout
 * JSON contract is untouched. No-op under --dry-run (no row comes back).
 */
export function warnIfPatchIgnored(
  patch: Partial<ChangelogAddBody>,
  result: unknown,
  warn: (msg: string) => void = warnNote
): void {
  if (!result || typeof result !== "object" || (result as Record<string, unknown>).dryRun) return;
  const row = result as Record<string, unknown>;
  const ignored = DEPLOY_GATED_PATCH_FIELDS.filter((f) => {
    const sent = patch[f];
    if (sent === undefined || !(f in row)) return false;
    // fb#576: --feedback is a LIST on the wire, but the row echoes the SCALAR
    // projection column (devChangelog.feedbackId = the first id given). `541 !==
    // [541]` is always true, so this fired on every SUCCESSFUL --feedback update
    // — and worse, it made the detector permanently USELESS for that flag: a
    // genuinely deploy-gated ignore became indistinguishable from the normal
    // case. Compare like with like.
    return row[f] !== (Array.isArray(sent) ? sent[0] : sent);
  });
  if (ignored.length)
    warn(
      `[ib] ⚠ the backend did not apply ${ignored.map((f) => `--${READ_SHAPE_KEY_ALIASES[f] ?? f.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`).join(", ")} — ` +
        `these became editable in a later puminet5api version, so this endpoint is silently ignoring them (fb#303). The rest of the patch was applied.`
    );
}

/**
 * Normalize `o.feedback` into `number[]` after the --from-json merge (fb#576).
 *
 * An EXPLICIT `--feedback` flag already arrives as `number[]` — Commander ran
 * {@link intCsvFlag} at parse time. But `--from-json`'s shared csvFields
 * handling (`_shared/fromJson.ts`) has no idea a field is meant to end up
 * numeric: it only knows how to produce a CSV STRING (pass a JSON string
 * through unchanged, or join a JSON array-of-strings with commas) — the same
 * treatment `files`/`repo`/`sha` get. So post-merge, `o.feedback` is either
 * already `number[]` (CLI-typed) or a raw CSV string (JSON-supplied), and the
 * string form still needs the same anchor-aware parse the flag itself uses.
 */
function normalizeFeedbackIds(v: unknown): number[] | undefined {
  if (v === undefined) return undefined;
  const ids = Array.isArray(v) ? (v as number[]) : intCsvFlag("--feedback")(String(v));
  // A blank `--feedback ""` parses to [] (fb#1284) — treat it as the flag being
  // omitted, so no `feedbackId` key is sent and no pre-check runs.
  return ids.length ? ids : undefined;
}

/**
 * Warn on stderr about what `--feedback` did to the row beyond linking it.
 *
 * Two side effects the caller did not ask for, both previously invisible in a
 * response that was a bare {"changelogId":N}:
 *
 * 1. RELINK — the row's resolvedByChangelogId was taken from a DIFFERENT entry.
 *    A row's work often lands in more than one entry (a fix, then a follow-up, a
 *    revert, a doc pass), and `--feedback` reads as "this entry relates to fb#N",
 *    not "this entry is now the sole resolver of fb#N". Re-pointing stays allowed
 *    — it is the correction path when the FIRST link was wrong — but anyone
 *    following the row afterwards lands on the follow-up instead of the fix, and
 *    the only way to notice was to go and look (fb#366).
 * 1b. LINK KEPT — the mirror of 1: the row was already owned by another entry,
 *    so the link was LEFT there and this entry is a plain cross-reference —
 *    either because --no-resolve was passed, or because the fb#880 pre-check
 *    demoted an `add` on an already-resolved row. Worth saying precisely because
 *    the old behaviour was the opposite (it took the link and reported a relink,
 *    fb#548) — a caller who remembers that would otherwise go "restore" a link
 *    that never moved.
 * 2. NOT RESOLVED — the link did not close the row, because its status was set
 *    deliberately (a `reviewed` legal draft awaiting activation) or because
 *    --no-resolve was passed. Worth saying, since linking a row normally DOES
 *    close it and the caller may be expecting that (fb#517/fb#441).
 * 3. NOT LINKED AT ALL — the id matched no row. The entry is still created, so
 *    the response looks like success; a typo'd id otherwise left the caller
 *    believing the row was closed while it stayed open forever (fb#543).
 * 4. THE LINK FAILED for this id (fb#586) — a DB-level failure on one id of a
 *    multi-id set. Distinct from 3: 3 is "no such row", 4 is "could not". Worth
 *    saying because the batch is one transaction PER id, so the rest of the set
 *    may have landed, and the entry itself certainly did.
 * 5. RESOLUTION PRESERVED across a status change (fb#633) — the link advanced the
 *    row to `applied` and a hand-written resolution note was kept (the fb#366
 *    preservation rule, which is RIGHT and is not changing). The two fields can
 *    then contradict each other: a row reading `status: applied` whose note opens
 *    "STILL OPEN — …" is how fb#567 ended up, and the next triage session reading
 *    that note would reasonably redo finished work. This is the only member of the
 *    group that used to pass unannounced. The fix is a SIGNAL, never a mutation —
 *    the note's whole value is that a human wrote it, so only the writer, who is
 *    right here, can say whether it still holds.
 *
 * `advancesStatus: false` marks the `update --feedback` path — the backend
 * passes advanceStatus:false there BY DESIGN (update is the link-repair /
 * correction path, not a report of shipped work; changelogSql.js:332), so the
 * `feedbackStatus` note states that rule instead of the add path's "only
 * `open` auto-advances" wording, which contradicted itself on a path where
 * nothing ever advances (fb#875).
 *
 * stderr only — the stdout JSON contract is untouched.
 */
export function warnFeedbackLinkEffects(
  result: unknown,
  warn: (msg: string) => void = warnNote,
  { advancesStatus = true }: { advancesStatus?: boolean } = {}
): void {
  if (!result || typeof result !== "object") return;
  const row = result as Record<string, unknown>;
  const { changelogId } = row;
  // A backend without fb#576 sends the outcome keys at the top level; a rebuilt
  // one sends feedbackLinks (one entry per --feedback id). Reading both keeps
  // the CLI useful across the deploy window in BOTH directions.
  const links = Array.isArray(row.feedbackLinks)
    ? (row.feedbackLinks as Array<Record<string, unknown>>)
    : [{ feedbackId: row.feedbackId, ...row }];

  for (const l of links) {
    const { relinkedFrom, linkKeptBy, feedbackStatus, feedbackLinked, feedbackId } = l;
    // Only name the row when there is a row to name — the legacy single-link
    // shape may not carry the id at all.
    const at = typeof feedbackId === "number" ? `fb#${feedbackId}: ` : "";
    // `feedbackLinked:false` covers BOTH "no such row" and "the link failed"
    // (fb#586), and they need opposite remedies — check the id vs retry it — so
    // the presence of `error` decides which of the two fires, never both.
    if (feedbackLinked === false && typeof l.error !== "string")
      warn(
        `[ib] ⚠ ${at}--feedback named a row that does not exist — cl#${changelogId} was created but NOTHING was linked for it. ` +
          `Check the id with \`ib dev feedback get <id>\`, then attach it with \`ib dev changelog update ${changelogId} --feedback <id>\`.`
      );
    if (typeof relinkedFrom === "number")
      warn(
        `[ib] note: ${at}that feedback row was already resolved by cl#${relinkedFrom}; cl#${changelogId} now owns the link. ` +
          `If you meant to cross-reference rather than re-resolve, restore it with \`ib dev changelog update ${relinkedFrom} --feedback <id>\`.`
      );
    if (typeof linkKeptBy === "number")
      warn(
        advancesStatus
          ? `[ib] note: ${at}that feedback row is still resolved by cl#${linkKeptBy} — the link was left there (--no-resolve, or the fb#880 cross-reference default for an already-resolved row), and cl#${changelogId} is recorded as a cross-reference only. ` +
            `Nothing to restore. To make cl#${changelogId} the resolver instead, re-run with --take-resolve (or \`ib dev changelog update ${changelogId} --feedback <id>\`).`
          : `[ib] note: ${at}that feedback row is still resolved by cl#${linkKeptBy} — --no-resolve left the link there, and cl#${changelogId} is recorded as a cross-reference only. ` +
            `Nothing to restore. To make cl#${changelogId} the resolver instead, re-run without --no-resolve (or \`ib dev changelog update ${changelogId} --feedback <id>\`).`
      );
    if (typeof feedbackStatus === "string")
      warn(
        advancesStatus
          ? `[ib] note: ${at}cl#${changelogId} is linked to that feedback row, but the row was left at \`${feedbackStatus}\` — NOT marked applied. ` +
              `A status set deliberately is preserved (only \`open\` auto-advances, and a REOPENED row does not). Close it with \`ib dev feedback resolve <id> --status applied\` once the change is actually live.`
          : `[ib] note: ${at}cl#${changelogId} is linked to that feedback row, but the row stays \`${feedbackStatus}\` — \`update --feedback\` only LINKS, it never advances status (linking is a correction, not a report of shipped work). ` +
              `Close it separately with \`ib dev feedback resolve <id> --status applied\` once the change is actually live.`
      );
    // 4. THE LINK FAILED for this id alone (fb#586). The other ids in the set
    //    may well have landed, and the entry exists either way, so the remedy is
    //    to finish the set — NOT to re-run `add`, which would mint a duplicate
    //    entry. Named per id because that is the whole point: before this, a
    //    mid-batch failure surfaced as a 500 that said nothing about which half
    //    of the list had already committed.
    if (typeof l.error === "string")
      warn(
        `[ib] ⚠ ${at}the link FAILED (${l.error}). cl#${changelogId} exists and the other ids in this call are reported separately — ` +
          `do NOT re-run \`add\` (that mints a duplicate entry); finish the set with \`ib dev changelog update ${changelogId} --feedback <the ids that failed>\`.`
      );
    // 5. The status MOVED and a hand-written resolution note survived (fb#633).
    //    Deploy-gated: `resolutionPreserved` only arrives from a backend carrying
    //    the fb#633 change, and its absence is indistinguishable from "nothing was
    //    preserved" — silence on an older backend is the pre-fix behaviour, never
    //    a wrong claim. The excerpt is the point: it lets the writer judge the
    //    contradiction without a second `ib dev feedback get`.
    const preserved = l.resolutionPreserved;
    if (preserved === true || typeof preserved === "string") {
      const excerpt = typeof preserved === "string" ? excerptNote(preserved) : null;
      warn(
        `[ib] ⚠ ${at}status advanced to \`applied\`, but the row's EXISTING resolution note was preserved — the two may now contradict each other` +
          (excerpt ? `: "${excerpt}"` : ".") +
          ` Re-read it with \`ib dev feedback get ${typeof feedbackId === "number" ? feedbackId : "<id>"}\` and, if it no longer holds, rewrite it with ` +
          `\`ib dev feedback resolve ${typeof feedbackId === "number" ? feedbackId : "<id>"} --status applied --note "<what actually shipped>"\`.`
      );
    }
  }
}

/**
 * First ~80 chars of a preserved resolution note, on ONE line (fb#633).
 *
 * The notes worth warning about are the long hand-written ones, and their first
 * sentence is what carries the contradiction ("STILL OPEN — but a building block
 * now exists…"). Newlines are folded because this lands in a stderr line that
 * must stay one line to read as one warning.
 */
export function excerptNote(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * Report what `--unlink` removed, and the one thing it deliberately did NOT do
 * (fb#585).
 *
 * Unlinking clears the junction row and both projections, but never touches the
 * feedback row's STATUS — silently reopening it would be the implicit status
 * side effect fb#578/fb#587 exist to remove. So when the removed link was the
 * one that had CLOSED the row, the row is left closed with no resolver, and the
 * caller has a decision to make. That is the case this names.
 *
 * The absence of `feedbackUnlinks` on the response is the DEPLOY GATE: an older
 * backend drops `unlinkFeedbackId` as an unknown body key and returns 200, so
 * without this check `--unlink` would report a confident success having removed
 * nothing.
 */
export function warnFeedbackUnlinkEffects(
  result: unknown,
  requestedIds: number[] | undefined,
  warn: (msg: string) => void = warnNote
): void {
  if (!requestedIds || requestedIds.length === 0) return;
  const row = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const { changelogId } = row;
  const unlinks = Array.isArray(row.feedbackUnlinks)
    ? (row.feedbackUnlinks as Array<Record<string, unknown>>)
    : null;

  if (!unlinks) {
    warn(
      `[ib] ⚠ --unlink had NO effect: this backend does not support it yet, and dropped it as an unknown field (the PUT still returned 200). ` +
        `Every link named is still in place — verify with \`ib dev changelog get ${changelogId}\`, and retry once puminet5api has deployed.`
    );
    return;
  }

  for (const u of unlinks) {
    const { feedbackId, unlinked, feedbackStatus, error } = u;
    const at = typeof feedbackId === "number" ? `fb#${feedbackId}: ` : "";
    if (typeof error === "string")
      warn(`[ib] ⚠ ${at}the unlink FAILED (${error}). The link is still in place; retry it.`);
    else if (unlinked === false)
      warn(
        `[ib] note: ${at}there was no link to cl#${changelogId} to remove — nothing changed. ` +
          `Check which entry actually holds it with \`ib dev feedback get <id>\`.`
      );
    else if (typeof feedbackStatus === "string")
      warn(
        `[ib] note: ${at}the link is gone, but the row is still \`${feedbackStatus}\` — unlinking never changes a status. ` +
          `If it was closed by the link you just removed, reopen it with \`ib dev feedback resolve ${typeof feedbackId === "number" ? feedbackId : "<id>"} --status open\`.`
      );
  }
}

export function registerChangelogCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const c = parent
    .command("changelog", { hidden: !!opts.hidden })
    .description(
      "Development changelog entries (source of the monthly report)"
    );

  addWriteFlagsToCommand(
    c
      .command("add [description]")
      // `create` — reciprocal hidden alias: `changelog` is the outlier that uses
      // `add` where every other group uses `create`, so an agent primed on
      // `create` types `changelog create`; accept it (feedback #229).
      .alias("create")
      // Required, but declared as plain options so --from-json can supply them:
      // Commander enforces a .requiredOption before the action runs. Enforced
      // post-merge by requireAddFields (fb#300).
      .option("--type <t>")
      .option("--area <a>", AREA_FLAG_DESC)
      .option("--title <s>")
      .option("--description <s>")
      .option("--summary <s>")
      .option("--body <s>")
      .option("--benefits <s>")
      .option("--impact <s>")
      .option("--status <s>")
      .option("--severity <s>", SEVERITY_FLAG_DESC)
      .option("--files <csv>")
      .option("--repo <r>", REPO_FLAG_DESC)
      .option("--sha <csv>")
      .option("--commit <csv>")
      .option("--vtag <s>")
      .option("--bump-level <l>", "", "patch")
      .option("--feedback <ids>", "", intCsvFlag("--feedback"))
      .option("--no-resolve")
      .option("--take-resolve")
      .option("--sentry <ref>")
      .option("--source <s>")
      .option("--date <d>")
      .option("--language <l>")
      .option(
        "--from-json <file>"
      )
  ).action(
    guarded(async (
      description: string | undefined,
      o: Record<string, string> & WriteFlags & { feedback?: number[]; resolve?: boolean; takeResolve?: boolean; vtag?: string; bumpLevel?: string; fromJson?: string },
      cmd: Command
    ) => {
      applyFromJson(cmd, o as Record<string, unknown>);
      // Fail-fast BEFORE enum/length/date validation: both flags are CLI-only
      // (nonPayload), and o.feedback may arrive via --from-json, so the earliest
      // correct point is right after the JSON merge.
      if (o.takeResolve && o.feedback === undefined) failWith("--take-resolve has no effect without --feedback", 4);
      if (o.takeResolve && o.resolve === false) failWith("--take-resolve contradicts --no-resolve — pass one or the other", 4);
      // A changelog entry is a permanent record whose prose routinely names flags
      // and identifiers — the text most likely to carry backticks (fb#552).
      warnIfShellMangled({ description: description ?? o.description, body: o.body, impact: o.impact, benefits: o.benefits });
      normalizeChangelogEnums(o);
      requireAddFields(description, o as Record<string, unknown>);
      validateEnums(o.type, o.area, o.bumpLevel, o.source, o.severity);
      o.sha = resolveShaAlias(o.sha, o.commit)!;
      validateFieldLengths(o);
      const entryDate = resolveDate(o.date || "today")!;
      const body: ChangelogAddBody = {
        type: o.type,
        area: o.area,
        title: o.title,
        description: resolveChangelogDescription(description, o.description, o.summary, o.body),
        entryDate,
      };
      if (o.benefits) body.benefits = o.benefits;
      if (o.impact) body.impact = o.impact;
      if (o.status) body.status = o.status;
      if (o.severity) body.severity = o.severity;
      if (o.files) body.files = filesToJson(o.files);
      if (o.repo) body.repo = o.repo;
      // fb#1351: the fully-unresolved (non-blank) branch that used to live here
      // is REMOVED, not reworded — it warned about a deferred deploy-time
      // fail-safe that can never actually happen for a non-blank token
      // (canonicalizeRepo hard-rejects it at add-time, 400/exit 4, before the
      // entry is ever persisted), so the POST below fails outright instead and
      // that rejection now carries its own errors[] row/remedy. A pre-emptive
      // warning here would just restate an inevitable failure with the wrong
      // explanation. Only the RECOGNIZED-STANDALONE reassurance still applies
      // client-side (feedback #354/#466 — read as reassurance, not rejection).
      if (o.repo && (o.bumpLevel || "patch") !== "none") {
        const { coordinated, canonical } = normalizeRepoCsv(o.repo);
        if (coordinated.length === 0 && canonical.length > 0)
          warnNote(
            `[ib] note: --repo "${o.repo}" is a recognized standalone package, not a coordinated release repo — this entry bumps no app version, so --bump-level ${o.bumpLevel || "patch"} is inert (standalone packages are auto-bumped by \`npm run final\`). This is fine; nothing to do.`
          );
      }
      if (o.sha) body.commitShas = o.sha;
      if (o.vtag) body.versionTag = o.vtag;
      // normalizeFeedbackIds always yields number[] for a defined input, so the
      // pre-check can work off this local instead of re-deriving from body.
      const feedbackIds = o.feedback !== undefined ? normalizeFeedbackIds(o.feedback) : undefined;
      if (feedbackIds) body.feedbackId = feedbackIds;
      // Only sent when --no-resolve was actually passed: Commander defaults
      // `resolve` to true, and shipping that default would make every add assert a
      // resolve intent it never expressed.
      if (o.resolve === false) body.resolveFeedback = false;
      const client = await getClient();
      // fb#880: a follow-up entry to an ALREADY-resolved row used to silently
      // STEAL the resolves-link, demoting the original fix entry. Pre-check the
      // rows and default to role `references` instead; --take-resolve restores
      // the deliberate re-own. Open rows keep the historical auto-resolve, and
      // --no-resolve already forces references so neither needs the pre-check.
      // Fail-open: an id whose pre-check GET errors keeps the old behaviour
      // (the `relinkedFrom` stderr note still fires if it turns out resolved).
      if (feedbackIds && o.resolve !== false && !o.takeResolve) {
        const already = await findAlreadyResolvedFeedback(client, feedbackIds);
        if (already.length > 0) {
          body.resolveFeedback = false;
          // resolveFeedback is PER-REQUEST: one already-resolved id demotes the
          // WHOLE call, so any still-open ids in the same CSV also link as
          // references and are NOT advanced. Name them explicitly — otherwise
          // the fired feedbackStatus note blames a "deliberately set" status for
          // what is actually this demotion (fb#880 review M2).
          const resolvedIds = new Set(already.map((a) => a.feedbackId));
          const openIds = feedbackIds.filter((id) => !resolvedIds.has(id));
          warnNote(
            `[ib] note: ${already
              .map((a) => `fb#${a.feedbackId} is already resolved by cl#${a.resolvedByChangelogId}`)
              .join("; ")} — resolveFeedback is per-request, so the WHOLE entry links as a cross-reference (role \`references\`) instead of taking the resolves role. ` +
              (openIds.length > 0
                ? `That also covers the still-open id(s) ${openIds.map((id) => `fb#${id}`).join(", ")} in this call — they link as references and are NOT advanced; resolve them with a separate \`changelog add\`/\`update\` or \`ib dev feedback resolve\`. `
                : "") +
              `To re-resolve the already-resolved row(s) deliberately, re-run with --take-resolve.`
          );
        }
      }
      if (o.sentry) body.sentryIssue = normalizeSentryRef(o.sentry);
      if (o.source) body.source = o.source;
      const addLang = normalizeLanguage(o.language);
      if (addLang) body.language = addLang;
      body.bumpLevel = o.bumpLevel || "patch";
      const added = await runChangelogAdd(client, body, o);
      warnFeedbackLinkEffects(added);
      writeJson(added);
    })
  );

  c.command("list")
    .option("--month <YYYY-MM>")
    .option("--type <t>")
    .option("--area <a>", AREA_FLAG_DESC)
    .option("--repo <r>")
    .option("--feedback <id>", "", intFlag("--feedback"))
    .option("--sentry <ref>")
    .option("--source <s>")
    .option("--search <text>")
    .option("--status <substr>")
    .option("--has-feedback")
    .option("--has-sentry")
    .option("--unreleased")
    .option("--pending")
    .option("--limit <n>", "", cappedInt(500))
    // The backend has ALWAYS supported offset (listEntries binds it); only the
    // flag was missing, which made everything below the 500-row cap unreachable
    // through this command (fb#605). Its sibling `ib dev feedback list` has had
    // --offset all along.
    .option("--offset <n>", "", intFlag("--offset", 0))
    .action(
      guarded(async (o: Record<string, string | number | boolean>) => {
        // --unreleased/--pending is the pending-queue view, not a month filter;
        // route it to the dedicated endpoint so the literal command an agent
        // reaches for works (feedback #196/#197).
        if (o.unreleased || o.pending) {
          writeJson(await runChangelogPending(await getClient()));
          return;
        }
        writeJson(await runChangelogList(await getClient(), o));
      })
    );

  c.command("get <changelogId>")
    // `show` — the reflex spelling for read-one-row (feedback #373).
    .alias("show")
    .action(
      guarded(async (idStr: string) => {
        const id = parseRefId(idStr, "changelog", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "feedback", () => runChangelogGet(client, id)));
      })
    );

  addWriteFlagsToCommand(
    c
      .command("delete <changelogId>")
  ).action(
    guarded(async (idStr: string, o: WriteFlags) => {
      const id = parseRefId(idStr, "changelog", "delete");
      const client = await getClient();
      writeJson(await runWithSiblingHint(client, id, "feedback", () => runChangelogDelete(client, id, o)));
    })
  );

  addWriteFlagsToCommand(
    c
      .command("update <changelogId>")
      .option("--type <t>")
      .option("--area <a>", AREA_FLAG_DESC)
      .option("--title <s>")
      .option("--description <s>")
      .option("--append-description <s>", "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the existing entry text intact; mutually exclusive with --description/--summary/--body")
      .option("--summary <s>")
      .option("--body <s>")
      .option("--benefits <s>")
      .option("--impact <s>")
      .option("--status <s>")
      .option("--severity <s>", SEVERITY_FLAG_DESC)
      .option("--files <csv>")
      .option("--repo <r>")
      .option("--sha <csv>")
      .option("--commit <csv>")
      .option("--vtag <s>")
      // NO default, unlike `add`'s --bump-level (feedback #303). A Commander
      // default here would ride along on every unrelated patch — `update 7
      // --status Deployed` would silently rewrite a deliberate `minor` back to
      // `patch` and mis-drive the next deploy. Absent flag = field untouched.
      .option("--bump-level <l>")
      .option("--feedback <ids>", "", intCsvFlag("--feedback"))
      // `update` only: there is nothing to unlink from an entry `add` is still
      // creating (fb#585).
      .option("--unlink <ids>", "", intCsvFlag("--unlink"))
      .option("--no-resolve")
      .option("--sentry <ref>")
      .option("--source <s>")
      .option("--date <d>")
      .option("--language <l>")
      .option(
        "--from-json <file>"
      )
  ).action(guarded(async (idStr: string, o: Record<string, string> & WriteFlags & { vtag?: string; bumpLevel?: string; feedback?: number[]; unlink?: number[]; resolve?: boolean; fromJson?: string; appendDescription?: string }, cmd: Command) => {
    const id = parseRefId(idStr, "changelog", "update");
    applyFromJson(cmd, o as Record<string, unknown>);
    normalizeChangelogEnums(o);
    validateEnums(o.type, o.area, o.bumpLevel, o.source, o.severity, "ib dev changelog update");
    // --summary/--body are aliases for --description (feedback #205/#278); fold
    // them in before the patch build so the loop below picks them up. Several may
    // be given only when they agree.
    const desc = foldAliases(
      [o.description, o.summary, o.body],
      "Provide the description via --description, --summary, or --body, not several with different values"
    );
    if (desc !== undefined) o.description = desc;
    if (o.appendDescription !== undefined) {
      if (!o.appendDescription.trim()) failWith("--append-description must be non-empty", 4);
      if (desc !== undefined) {
        failWith("--append-description and --description (or --summary/--body) are mutually exclusive", 4);
      }
    }
    o.sha = resolveShaAlias(o.sha, o.commit)!;
    validateFieldLengths(o);
    const client = await getClient();
    // Read-merge-write: --description REPLACES the entry, which is destructive
    // (fb#757). Appending keeps the current text and adds to it instead.
    if (o.appendDescription !== undefined) {
      const current = await runChangelogGet(client, id);
      const existing = typeof current.description === "string" ? current.description : "";
      o.description = existing ? `${existing.trimEnd()}\n\n${o.appendDescription.trim()}` : o.appendDescription.trim();
    }
    const patch: Partial<ChangelogAddBody> = {};
    for (const k of [
      "type",
      "area",
      "title",
      "description",
      "benefits",
      "impact",
      "status",
      "severity",
      "repo",
      "source",
    ] as const) {
      if (o[k] !== undefined)
        (patch as Record<string, unknown>)[k] = o[k];
    }
    if (o.files) patch.files = filesToJson(o.files);
    if (o.sha) patch.commitShas = o.sha;
    if (o.vtag) patch.versionTag = o.vtag;
    if (o.date) patch.entryDate = resolveDate(o.date)!;
    if (o.bumpLevel !== undefined) patch.bumpLevel = o.bumpLevel;
    if (o.feedback !== undefined) patch.feedbackId = normalizeFeedbackIds(o.feedback);
    if (o.unlink !== undefined) patch.unlinkFeedbackId = normalizeFeedbackIds(o.unlink);
    if (o.resolve === false) patch.resolveFeedback = false;
    if (o.sentry) patch.sentryIssue = normalizeSentryRef(o.sentry);
    const updLang = normalizeLanguage(o.language);
    if (updLang) patch.language = updLang;
    const result = await runWithSiblingHint(client, id, "feedback", () =>
      runChangelogUpdate(client, id, patch, o)
    );
    warnIfPatchIgnored(patch, result);
    warnFeedbackLinkEffects(result, warnNote, { advancesStatus: false });
    warnFeedbackUnlinkEffects(result, o.unlink);
    writeJson(result);
  }));

  c.command("report")
    .option("--month <YYYY-MM>")
    .option("--unreleased")
    .option("--pending")
    .option("--format <f>", "", "md")
    .action(
      guarded(async (o: { month?: string; unreleased?: boolean; pending?: boolean; format: string }) => {
        // `report` covers already-RELEASED months; the unreleased/pending queue
        // has its own endpoint. Accept --unreleased/--pending here so the
        // natural `report --unreleased` an agent tries works instead of dead-
        // ending on "required option --month" (feedback #196/#197).
        if (o.unreleased || o.pending) {
          writeJson(await runChangelogPending(await getClient()));
          return;
        }
        if (!o.month)
          failWith(
            "--month <YYYY-MM> is required for a monthly report. For UNRELEASED/pending entries staged for the next release, use `ib dev changelog pending` (or `report --unreleased`).",
            4
          );
        if (!/^\d{4}-\d{2}$/.test(o.month))
          failWith("--month must be YYYY-MM", 4);
        assertEnum(o.format, ["md", "json"], "--format");
        writeJson(
          await runChangelogReport(await getClient(), o.month, o.format)
        );
      })
    );

  c.command("pending")
    .action(jsonAction(getClient, runChangelogPending));

  addWriteFlagsToCommand(
    c
      .command("release")
      .option("--vtag <v>")
      .option("--map <file>")
  ).action(guarded(async (o: WriteFlags & { vtag?: string; map?: string }) => {
    if ((o.vtag ? 1 : 0) + (o.map ? 1 : 0) !== 1) {
      failWith("provide exactly one of --vtag or --map", 4);
    }
    if (o.map) {
      let arr: unknown;
      try { arr = readJsonInput(o.map); } catch { failWith("--map: not valid JSON", 4); }
      if (!Array.isArray(arr)) failWith("--map: JSON root must be an array of {changelogId, versionTag}", 4);
      writeJson(await runChangelogReleaseMap(
        await getClient(),
        arr as Array<{ changelogId: number; versionTag: string }>,
        o
      ));
    } else {
      writeJson(await runChangelogRelease(await getClient(), o.vtag as string, o));
    }
  }));
}

export const CHANGELOG_SPECS: CommandSpec[] = [
  {
    command: "ib dev changelog add",
    aliases: ["ib dev changelog create"],
    description:
      "Add a change entry (feature|improvement|bugfix|docs). The monthly report is generated from these. --feedback <id> links that cliFeedback row and advances it to status=applied — but only from `open`; a status set deliberately (e.g. `reviewed`) is preserved, and --no-resolve links without touching the status at all. Already-resolved rows keep their resolver unless --take-resolve (fb#880).",
    auth: "any",
    tier: "developer",
    args: [{ name: "description", type: "string", description: "Kuvaus (or pass as --description) — free length, the column is nvarchar(max)" }],
    flags: withMaxLengths([
      {
        name: "type",
        type: "string",
        required: true,
        allowed: TYPES,
        synonyms: TYPE_SYNONYMS,
        description: "feature|improvement|bugfix|docs (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
      },
      {
        name: "area",
        type: "string",
        required: true,
        allowed: AREAS,
        description: AREA_FLAG_DESC,
      },
      {
        name: "title",
        type: "string",
        required: true,
        description: "Entry title",
      },
      {
        name: "description",
        type: "string",
        requiredGroup: "description input",
        description: "Alias for the positional description; one positional/description/summary/body input is required, and if several are passed they must match",
      },
      {
        name: "summary",
        type: "string",
        requiredGroup: "description input",
        description: "Alias for --description (same one-required description-input group; several passed must match)",
      },
      {
        name: "body",
        type: "string",
        requiredGroup: "description input",
        description: "Alias for --description, free text — NOT the raw-JSON --body of the update commands (same one-required group)",
      },
      { name: "benefits", type: "string", description: "Hyödyt" },
      { name: "impact", type: "string", description: "Vaikutus" },
      { name: "status", type: "string", description: "Tila (Julkaistu/Korjattu/...)" },
      {
        name: "severity",
        type: "string",
        description: SEVERITY_FLAG_DESC,
        allowed: [...SEVERITIES],
        synonyms: SEVERITY_SYNONYMS,
      },
      { name: "files", type: "string", description: "CSV of file paths" },
      { name: "repo", type: "string", description: REPO_FLAG_DESC },
      { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
      { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
      { name: "vtag", type: "string", description: "Version tag" },
      { name: "bump-level", type: "string", default: "patch", allowed: BUMP_LEVELS, description: "App version bump this implies: none|patch|minor|major" },
      {
        name: "feedback",
        type: "string",
        description:
          "cliFeedback id(s) to link — a single id or CSV (`541,542`), `fb#` anchors accepted. Role `resolves` (default) advances an `open` row to applied; a deliberately-set status (e.g. `reviewed`) is preserved and reported on stderr (fb#517/576). Linking an ALREADY-resolved row keeps its resolver by DEFAULT — a cross-reference, stderr says so (fb#880); --take-resolve re-owns it (fb#366). resolveFeedback is per-REQUEST: one already-resolved id demotes the WHOLE call.",
      },
      {
        name: "no-resolve",
        type: "boolean",
        description:
          "Record the link(s) with role `references` instead of `resolves`: no status change, an already-resolved row keeps its resolver (fb#548). Applies to EVERY id in the list; for a mixed entry, add the resolving ids here and cross-reference the rest with a second `changelog update … --no-resolve`.",
      },
      {
        name: "take-resolve",
        type: "boolean",
        description:
          "Force role `resolves` on an ALREADY-resolved row — the deliberate re-own / correction path (fb#366). Without it, such a row links as a cross-reference (fb#880). Conflicts with --no-resolve.",
      },
      {
        name: "sentry",
        type: "string",
        description: "Sentry issue short id or URL this entry fixes (stored, not sent to Sentry)",
      },
      {
        name: "source",
        type: "string",
        allowed: SOURCES,
        description: "Source: human (default) | routine (automated AI-routine entry)",
      },
      {
        name: "date",
        type: "date",
        description: "Entry date (YYYY-MM-DD|today)",
      },
      { name: "language", type: "string", allowed: LANGUAGES, description: "Entry language (fi|en), default en" },
      {
        name: "from-json",
        type: "string",
        description:
          "Read the whole entry's CONTENT from a JSON object file (or - for stdin); explicitly-typed flags override. Content keys, in camelCase: description (or summary/body), title (≤300), type, area, benefits, impact (≤500), status (≤30), severity (≤20), files, repo (≤200), sha (≤500), commit, vtag (≤200), bumpLevel (`bump-level` also accepted), feedback, sentry, source, date, language. files/repo/sha/commit also accept an array of strings. The READ shape is also accepted as input (commitShas→sha, versionTag→vtag, feedbackId→feedback, sentryIssue→sentry, entryDate→date), so a `changelog list` row can be edited and posted straight back. " +
          fromJsonNonPayloadDesc(true) +
          " An unknown or wrong-typed key exits 4 (never silently dropped); the length caps apply to a JSON value exactly as to a flag.",
      },
    ]),
    writeFlags: true,
    dryRunKind: "server",
    outputShape:
      "{ changelogId, feedbackLinks: [{ feedbackId, role, relinkedFrom?, linkKeptBy?, feedbackStatus?, feedbackLinked?, resolutionPreserved? }] } | { dryRun, wouldCreate, validation }. " +
      FEEDBACK_LINKS_SHAPE_DESC +
      " — the ENTRY was still created, only that link failed (fb#543); " +
      RESOLUTION_PRESERVED_SHAPE_DESC +
      " " +
      SINGLE_LINK_MIRROR_DESC,
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer access required",
        remedy: "use a developer token",
      },
      {
        http: 400,
        exit: 4,
        match: ["repo has unknown token"],
        meaning: "Validation (unresolved --repo token)",
        remedy: "unrecognized token — see --help for the accepted tiers, or leave --repo blank for the deploy-time fail-safe instead. Matched case-insensitively against a fixed alias table, not fuzzy.",
      },
      {
        http: 400,
        exit: 4,
        meaning: "Validation (bad enum/date)",
        remedy: "check --type/--area/--date",
      },
      {
        http: 401,
        exit: 2,
        meaning: "Token expired",
        remedy: "ib auth refresh",
      },
      {
        origin: "client",
        exit: 4,
        match: "too many arguments",
        meaning: "too many arguments — the shell split a quoted flag value on its inner double-quotes (typical on Windows PowerShell)",
        remedy: "Pass the whole entry via --from-json <file|-> instead of argv",
      },
      {
        origin: "client",
        exit: 4,
        match: "--from-json",
        meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key",
        remedy: "The error says WHICH of the four: an unopenable path, a JSON syntax error (no field has been read yet, so the key names are not the problem), a root that is not an object, or an unknown / wrong-typed key. Only the last two are about field names",
      },
      {
        origin: "client",
        exit: 4,
        match: "value too long",
        meaning: "a bounded free-text flag exceeds its devChangelog column width",
        remedy: "trim the named flag by the stated overflow — a column-width limit, so --from-json does not help",
      },
    ],
    notes: [
      "You can pass the description positionally, as --description, or as its --summary/--body aliases — if you pass more than one they must match (mirrors `ib dev feedback create`). Here --body is FREE TEXT, unlike the raw-JSON --body on the entity update commands.",
      "SHELL QUOTING (fb#300): an entry description is prose about code — the text most likely to carry inner double-quotes, which Windows PowerShell splits on. Pass quote-bearing entries via --from-json <file|-> (required --type/--area/--title may come from the JSON); see `ib help shell-quoting`.",
      'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev changelog add --type bugfix --area cli --title "x" -- "-5% render time". Everything after `--` is taken as positional text.',
      "--dry-run is SERVER-side (X-Dry-Run): the backend validates then echoes wouldCreate without inserting — a bad --type/--area/--date still 400s.",
      "Bounded free-text flags are length-checked client-side (exit 4) before POSTing: --status ≤30, --severity ≤20, --title ≤300, --impact ≤500, --repo/--vtag ≤200, --sha ≤500. (--description/--benefits/--files are unbounded.)",
      'CROSS-LANE ENTRIES (fb#408): --repo is a CSV; a change spanning both lanes names both — --repo "puminet5api,betonicli" — each token is bumped/stamped on its own. Demoting one lane to --files loses the attribution.',
      "--feedback on an ALREADY-resolved row links as a CROSS-REFERENCE by default (fb#880) — the response's `linkKeptBy` names the keeping resolver (nothing to restore). --take-resolve re-owns it (fb#366): only then the response carries `relinkedFrom` (restore: `ib dev changelog update <thatId> --feedback <id>`).",
      "DEPLOY-GATED link behaviours (fb#366/441/517/548/576): CSV --feedback, --no-resolve, the status-preserve rule, and the relinkedFrom/linkKeptBy/feedbackStatus echoes each need a recent puminet5api — and against an older backend some degrade SILENTLY (--no-resolve is dropped as an unknown body key and the row force-flips to applied). ALWAYS verify with `ib dev feedback get <id>` after linking; full per-flag matrix: `ib reference detail get dev changelog add`.",
      SERVER_ENUM_NOTE,
      "Developer-gated.",
    ],
    seeAlso: ["ib dev changelog report", "ib dev feedback resolve"],
    examples: [
      'ib dev changelog add --type bugfix --area cli --title "x" --description "y" --feedback 12 --sha 59d9cc5',
      'ib dev changelog add "positional description works too" --type bugfix --area cli --title "x"',
      'ib dev changelog add --type feature --area backend --title "x" --body "gh-style --body works as a --description alias"',
      'ib dev changelog add --type bugfix --area backend --title "fix npe" --description "y" --sentry PUMINET5API-1A2',
      'ib dev changelog add --type feature --area cli --title "x" --description "y" --repo "puminet5api,betonicli"',
      "ib dev changelog add --from-json ./entry.json",
      "ib dev changelog add --from-json ./entry.json --bump-level minor",
    ],
  },
  {
    command: "ib dev changelog list",
    description: "List change entries with filters.",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "month", type: "string", description: "YYYY-MM" },
      {
        name: "type",
        type: "string",
        description: "feature|improvement|bugfix|docs",
      },
      {
        name: "area",
        type: "string",
        description: AREA_FLAG_DESC,
      },
      {
        name: "repo",
        type: "string",
        description:
          "Repo/submodule — matches entries whose --repo CSV CONTAINS this token, so `--repo betonicli` also returns cross-lane rows recorded as \"puminet5api,betonicli\" (deploy-gated: against an older backend this is an exact string match and those rows are invisible). Aliases resolve (`cli` → betonicli); a CSV here matches rows containing ANY of the tokens.",
      },
      {
        name: "feedback",
        type: "number",
        description: "linked feedback id",
      },
      {
        name: "sentry",
        type: "string",
        description: "linked Sentry issue short id",
      },
      { name: "source", type: "string", description: "human|routine" },
      {
        name: "search",
        type: "string",
        description: "Substring match over title/description/files/commitShas (deploy-gated)",
      },
      {
        name: "status",
        type: "string",
        description: "Substring match on the free-text status field, e.g. 'Deployed' (deploy-gated)",
      },
      {
        name: "has-feedback",
        type: "boolean",
        description: "Only entries linked to a feedback id (deploy-gated)",
      },
      {
        name: "has-sentry",
        type: "boolean",
        description: "Only entries linked to a Sentry issue (deploy-gated)",
      },
      {
        name: "unreleased",
        type: "boolean",
        description: "List only UNRELEASED/pending entries (versionTag IS NULL) + the max bump level — routes to `changelog pending`",
      },
      { name: "pending", type: "boolean", description: "Alias for --unreleased" },
      {
        name: "limit",
        type: "number",
        default: "100",
        description: "Max rows, HARD-CAPPED at 500 by the backend. Asking for more is not an error and not honoured — you get 500 rows and a stderr warning; `truncated: true` in the envelope says the page was capped (fb#605). Page the rest with --offset.",
      },
      {
        name: "offset",
        type: "number",
        default: "0",
        description: "Skip N rows — the ONLY way to reach entries beyond the 500-row cap (the backend has always supported it; the flag was missing until fb#605). Combine with --limit to page: `--limit 500`, then `--limit 500 --offset 500`.",
      },
    ],
    outputShape: "ListEnvelope<entry> (`truncated: true` when the row cap bit — the page is NOT the whole result) | (with --unreleased) { items, entries, maxBumpLevel, count }",
    errors: [
      {
        origin: "client",
        exit: 4,
        match: "--limit must be an integer >= 1",
        meaning: "--limit is not an integer >= 1, rejected locally before any request",
        remedy: "pass a positive integer; this command caps at 500 — page past it with --offset",
      },
      {
        origin: "client",
        exit: 4,
        match: "--offset must be an integer >= 0",
        meaning: "--offset is not an integer >= 0, rejected locally before any request",
        remedy: "pass a non-negative integer row offset",
      },
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
    ],
    notes: [
      "--search / --status / --has-feedback / --has-sentry are server-side filters added in a later backend version; against an older backend they are silently ignored (the list returns unfiltered) — deploy-gated.",
      "--unreleased/--pending ignores every other filter and returns the pending queue (`changelog pending`): the entries that drive the next deploy's per-repo version bump, plus the implied max bump level.",
    ],
    examples: [
      "ib dev changelog list --month 2026-06 --type feature",
      "ib dev changelog list --search weather",
      "ib dev changelog list --has-feedback --status Deployed",
      "ib dev changelog list --unreleased",
    ],
  },
  {
    command: "ib dev changelog get",
    aliases: ["ib dev changelog show"],
    description: "Get one change entry.",
    auth: "any",
    tier: "developer",
    args: [
      {
        name: "changelogId",
        type: "number",
        description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)",
      },
    ],
    flags: [],
    outputShape: "entry",
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
      {
        http: 404,
        exit: 5,
        meaning: "Not found",
        remedy: "ib dev changelog list — a bare id that is actually a feedback id 404s here and the error hint names the feedback command (feedback #230)",
      },
    ],
    examples: ["ib dev changelog get 7", "ib dev changelog get cl#7"],
  },
  {
    command: "ib dev changelog update",
    description: "Edit a change entry.",
    auth: "any",
    tier: "developer",
    args: [
      {
        name: "changelogId",
        type: "number",
        description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)",
      },
    ],
    flags: withMaxLengths([
      {
        name: "type",
        type: "string",
        allowed: TYPES,
        synonyms: TYPE_SYNONYMS,
        description: "feature|improvement|bugfix|docs (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
      },
      {
        name: "area",
        type: "string",
        allowed: AREAS,
        description: AREA_FLAG_DESC,
      },
      { name: "title", type: "string", description: "New title" },
      {
        name: "description",
        type: "string",
        description:
          "New description — REPLACES the whole text (destructive; use --append-description to add to it instead)",
      },
      {
        name: "append-description",
        type: "string",
        description: "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the existing entry text intact. Mutually exclusive with --description/--summary/--body",
      },
      { name: "summary", type: "string", description: "Alias for --description; if both are passed, they must match" },
      { name: "body", type: "string", description: "Alias for --description (free text, not JSON); if both are passed, they must match" },
      { name: "benefits", type: "string", description: "Hyödyt" },
      { name: "impact", type: "string", description: "Vaikutus" },
      {
        name: "status",
        type: "string",
        description: "Status update (e.g. mark deployed)",
      },
      { name: "severity", type: "string", description: SEVERITY_FLAG_DESC, allowed: [...SEVERITIES], synonyms: SEVERITY_SYNONYMS },
      { name: "files", type: "string", description: "CSV of file paths" },
      { name: "repo", type: "string", description: "Repo(s) this entry ships in (CSV) — replaces the recorded value wholesale, so re-send every repo, not just the added one" },
      { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
      { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
      { name: "vtag", type: "string", description: "Version tag" },
      {
        name: "bump-level",
        type: "string",
        allowed: BUMP_LEVELS,
        description:
          "Correct the app version bump this entry implies: none|patch|minor|major. NO default — omitting it leaves the recorded level untouched. Refused once the entry is RELEASED (has a versionTag).",
      },
      {
        name: "feedback",
        type: "string",
        description:
          "cliFeedback id(s) to link — a single id or CSV, `fb#` anchors accepted. `update` is the CORRECTION path: it records/repairs the link and NEVER changes the row's status (fb#578) — close a row with `ib dev feedback resolve <id> --status applied`; `changelog add` is what advances rows. Linking an ALREADY-resolved row TAKES it (stderr names the displaced entry); hand-written and `Shipped:` notes are preserved (fb#366/576).",
      },
      {
        name: "unlink",
        type: "string",
        description:
          "REMOVE this entry's link to the named cliFeedback id(s) (single id or CSV, `fb#` ok) — the undo for a mistyped --feedback (fb#585), which ADDS links and cannot correct itself. Repair in one call: `--unlink 541 --feedback 542` (unlink applies first; the same id in both flags exits 4). Clears the junction row and the projections that pointed HERE (auto `Shipped:` notes naming this entry included; hand-written notes kept). Never changes the row's status — a row closed by the removed link stays closed, reported on stderr (reopen via `ib dev feedback resolve <id> --status open`).",
      },
      {
        name: "no-resolve",
        type: "boolean",
        description:
          "Record the link(s) with role `references` instead of `resolves`: no status change, an already-resolved row keeps its resolver (fb#548). Applies to EVERY id in the list; for a mixed entry, add the resolving ids first and cross-reference the rest with a second `changelog update … --no-resolve`.",
      },
      {
        name: "sentry",
        type: "string",
        description: "Sentry issue short id or URL this entry fixes (stored, not sent to Sentry)",
      },
      { name: "source", type: "string", allowed: SOURCES, description: "Source: human|routine" },
      {
        name: "date",
        type: "date",
        description: "Entry date (YYYY-MM-DD|today)",
      },
      { name: "language", type: "string", allowed: LANGUAGES, description: "Entry language (fi|en)" },
      {
        name: "from-json",
        type: "string",
        description:
          "Read the patch CONTENT from a JSON object file (or - for stdin); explicitly-typed flags override. Content keys, in camelCase (description/summary/body, appendDescription, title, type, area, benefits, impact, status, severity, files, repo, sha, commit, vtag, bumpLevel (`bump-level` also accepted), feedback, sentry, source, date, language); files/repo/sha/commit also accept an array of strings. The READ shape is also accepted as input (commitShas→sha, versionTag→vtag, feedbackId→feedback, sentryIssue→sentry, entryDate→date), so a row from `ib dev changelog list` can be edited and posted straight back. " +
          fromJsonNonPayloadDesc(false) +
          " Pass them alongside the file. (`unlink` IS a content key and belongs in the file.) An unknown or wrong-typed key exits 4 (never silently dropped).",
      },
    ]),
    writeFlags: true,
    dryRunKind: "client",
    outputShape:
      "entry & { feedbackLinks: [{ feedbackId, role, relinkedFrom?, linkKeptBy?, feedbackStatus?, feedbackLinked?, resolutionPreserved? }] } | { dryRun, wouldUpdate: { id, patch } }. " +
      FEEDBACK_LINKS_SHAPE_DESC +
      "; " +
      RESOLUTION_PRESERVED_SHAPE_DESC +
      " " +
      SINGLE_LINK_MIRROR_DESC,
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
      {
        // fb#1384: update shares canonicalizeRepo with add (same validator,
        // same message), so the same dedicated row belongs here too — see
        // add's identical row for why it needs its own `match` rather than
        // folding into the catch-all below.
        http: 400,
        exit: 4,
        match: ["repo has unknown token"],
        meaning: "Validation (unresolved --repo token)",
        remedy: "unrecognized token — see `ib dev changelog add --help` for the accepted tiers, or leave --repo blank for the deploy-time fail-safe instead. Matched case-insensitively against a fixed alias table, not fuzzy.",
      },
      {
        // ONE row per status was once forced: hintForError served the FIRST http
        // match, so a second 400 row was dead and mis-remedied the other case
        // (fb#374). A second row is now possible IF it carries `match` (fb#485) —
        // this one stays the catch-all (no `match`), and both causes it names are
        // reported by the same backend validator, so splitting them would need a
        // substring that reliably tells them apart.
        http: 400,
        exit: 4,
        meaning:
          "Validation — a bad enum/language value, OR --bump-level on an already-RELEASED entry (one carrying a versionTag; that bump has already shipped)",
        remedy:
          "For enums the error names the allowed values (language must be fi|en). For a released entry leave the level as recorded — every other field is still editable; only UNRELEASED entries (ib dev changelog pending) still drive a deploy.",
      },
      {
        origin: "client",
        exit: 4,
        match: "--from-json",
        meaning: "--from-json file is unreadable, not valid JSON, not a JSON object, or carries an unknown / wrong-typed key",
        remedy: "The error says WHICH of the four: an unopenable path, a JSON syntax error (no field has been read yet, so the key names are not the problem), a root that is not an object, or an unknown / wrong-typed key. Only the last two are about field names",
      },
      {
        origin: "client",
        exit: 4,
        match: "value too long",
        meaning: "a bounded free-text flag exceeds its devChangelog column width",
        remedy: "trim the named flag by the stated overflow — a column-width limit, so --from-json does not help",
      },
      {
        origin: "client",
        exit: 4,
        match: "--append-description",
        meaning: "--append-description is empty, or combined with --description/--summary/--body",
        remedy: "--append-description must be non-empty and is mutually exclusive with a full --description replace — use one or the other",
      },
    ],
    notes: [
      "SHELL QUOTING (fb#300): this is the CORRECTION command, so the retry hits the quoting hazard again — pass quote-bearing prose via --from-json <file|->; see `ib help shell-quoting`.",
      "--append-description (fb#757) is the non-destructive twin of --description, mirroring `ib dev feedback update`: it fetches the current entry, joins the new text onto the end separated by a blank line, and PUTs the merged result — the original entry text is never lost. Exclusive with --description/--summary/--body (exit 4 if combined).",
      "THE CORRECTION PATH FOR --bump-level (fb#303). Deploy Step 0 bumps each coordinated repo from the MAX bump level across the UNRELEASED entries naming it, so a wrong level mis-drives a real release. Fix it here — do NOT delete + re-add, which mints a new changelogId and orphans the cliFeedback row pointing at the old one.",
      "--bump-level has NO default here (unlike `add`, where it defaults to patch): omitting it leaves the recorded level untouched, so an unrelated `update --status …` cannot silently downgrade a deliberate minor.",
      "--feedback re-establishes a link lost to delete + re-add — the only way to do it (`ib dev feedback resolve` sets status/resolution but not the link). It sets resolvedByChangelogId back to this entry but does NOT mark the row applied: since fb#578 this command writes no status at all, so close the row yourself with `ib dev feedback resolve <id> --status applied` once the change is live.",
      "--unlink is the UNDO for --feedback (fb#585). --feedback ADDS a link (the junction allows many), so it cannot correct a mistyped id on its own — `--unlink 541 --feedback 542` does, in one call, and the unlink is applied first. It never changes a status: a row closed by the removed link stays closed and is reported on stderr.",
      "A multi-id --feedback/--unlink set is one transaction PER id, not one across the set (fb#586). If one id fails, the others still run and each is reported separately — finish the set with another `changelog update`, and do NOT re-run `add`, which mints a duplicate entry.",
      "DEPLOY-GATED behaviours (fb#441/517/576/585 + field editability): --unlink, --no-resolve, CSV --feedback, the status-preserve rule, and --bump-level/--feedback/--sentry editability each need a recent puminet5api. The CLI detects and warns where it can (echo-compare on edits; missing `feedbackUnlinks`), but --no-resolve against an older backend is dropped SILENTLY and the row force-flips to applied. ALWAYS verify with `ib dev feedback get <id>` after linking; full per-flag matrix: `ib reference detail get dev changelog update`.",
      SERVER_ENUM_NOTE,
    ],
    seeAlso: ["ib dev changelog pending", "ib dev changelog get"],
    examples: [
      'ib dev changelog update 7 --status "Deployed prod"',
      "ib dev changelog update 386 --language en",
      'ib dev changelog update 386 --bump-level none --reason "docs-only, should not bump"',
      "ib dev changelog update 386 --from-json ./patch.json",
      'ib dev changelog update 1280 --unlink 541 --feedback 542 --reason "linked the wrong fb id"',
      'ib dev changelog update 1547 --append-description "Reviewed: verified fix landed in prod, no regressions."',
    ],
  },
  {
    command: "ib dev changelog delete",
    description:
      "Soft-delete a change entry (isDeleted=1; retained for audit, hidden from all reads, no CLI undelete).",
    auth: "any",
    tier: "developer",
    args: [{ name: "changelogId", type: "number", description: "Entry id — accepts an optional `cl#` anchor (e.g. `cl#858`); a `fb#` id is rejected (exit 4) with the feedback command to use (feedback #230)" }],
    flags: [],
    writeFlags: true,
    dryRunKind: "client",
    outputShape: "{ deleted: true } | { dryRun, wouldDelete }",
    errors: [
      { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
      { http: 404, exit: 5, meaning: "Not found (or already deleted)", remedy: "ib dev changelog list — a bare id that is actually a feedback id 404s here and the error hint names the feedback command (feedback #230)" },
    ],
    notes: [
      "Soft-delete: sets isDeleted=1 — the row is kept for audit but hidden from every read (get/list/report/pending), and there is no CLI undelete.",
      "Deleting an already-released entry (one with a versionTag) removes it from that month's generated report.",
      "Deleting an already-deleted/missing id returns 404 (exit 5), not a no-op.",
      "Developer-gated.",
    ],
    seeAlso: ["ib dev changelog update", "ib dev changelog get"],
    examples: [
      'ib dev changelog delete 805 --reason "test entry cleanup"',
      "ib dev changelog delete 805 --dry-run",
    ],
  },
  {
    command: "ib dev changelog report",
    description:
      "Generate the monthly report (markdown or json) from entries.",
    auth: "any",
    tier: "developer",
    flags: [
      {
        name: "month",
        type: "string",
        description: "YYYY-MM (required unless --unreleased)",
      },
      {
        name: "unreleased",
        type: "boolean",
        description: "Report UNRELEASED/pending entries staged for the next release instead of a month — routes to `changelog pending`",
      },
      { name: "pending", type: "boolean", description: "Alias for --unreleased" },
      {
        name: "format",
        type: "string",
        default: "md",
        description: "md|json",
      },
    ],
    outputShape: "{ month, markdown } | { month, rows } | (with --unreleased) { items, entries, maxBumpLevel, count }",
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
      {
        origin: "client",
        exit: 4,
        meaning: "Neither --month nor --unreleased given (or bad --month)",
        remedy: "pass --month YYYY-MM for a released month, or --unreleased for the pending queue",
      },
    ],
    notes: [
      "--month (YYYY-MM) renders a released monthly report; --unreleased/--pending instead returns the pending queue (`changelog pending`) staged for the next release. Exactly one is needed.",
    ],
    seeAlso: ["ib dev changelog pending"],
    examples: [
      "ib dev changelog report --month 2026-06",
      "ib dev changelog report --unreleased",
    ],
  },
  {
    command: "ib dev changelog pending",
    description:
      "List PENDING/unreleased changelog entries (versionTag IS NULL) staged for the next release, + the max bump level they imply. Drives the deploy-time app version bump.",
    auth: "any",
    tier: "developer",
    flags: [],
    outputShape:
      "{ items, entries, maxBumpLevel, count } — `items` is the canonical list key; `entries` is a back-compat alias of the same array (fb#163)",
    errors: [{ http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" }],
    notes: [
      "This is the unreleased/pending view (mirrors `ib dev feedback list --unresolved`). `ib dev changelog list --unreleased` and `ib dev changelog report --unreleased` are aliases that route here; `report --month` covers already-released months.",
    ],
    seeAlso: ["ib dev changelog report", "ib dev changelog release"],
    examples: ["ib dev changelog pending"],
  },
  {
    command: "ib dev changelog release",
    description:
      "Stamp unreleased entries with a version tag (marks them released). Called by scripts/apply-release-version.ps1. Use --vtag to stamp them all with one tag, or --map for precise per-entry repo@version tags.",
    auth: "any",
    tier: "developer",
    flags: [
      { name: "vtag", type: "string", description: "Single version tag to stamp on all pending entries (e.g. 1.0.8)" },
      { name: "map", type: "string", description: "JSON file (or -): [{changelogId, versionTag}] for precise per-entry stamping" },
    ],
    writeFlags: true,
    dryRunKind: "server",
    outputShape: "{ released, versionTag } | { released, mode:'map' } | { dryRun, wouldRelease, validation }",
    errors: [
      { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
      { http: 400, exit: 4, meaning: "Validation (need --vtag or --map)", remedy: "pass exactly one of --vtag/--map" },
      {
        origin: "client",
        exit: 4,
        match: "exactly one of",
        meaning: "Neither or both of --vtag/--map given — the guard fires before any request",
        remedy: "pass exactly one of --vtag (one tag for all pending entries) or --map (per-entry {changelogId, versionTag} array)",
      },
      {
        origin: "client",
        exit: 4,
        match: "--map:",
        meaning: "--map file is unreadable, not valid JSON, or its root is not an array",
        remedy: "check the path; the root must be a JSON array of { changelogId, versionTag }",
      },
    ],
    notes: [
      "Developer-gated.",
      "Provide exactly one of --vtag (one tag for all) or --map (precise per-entry repo@version).",
      "Typically invoked by scripts/apply-release-version.ps1, not by hand.",
    ],
    examples: [
      "ib dev changelog release --vtag 1.0.8 --reason 'release 1.0.8'",
      "ib dev changelog release --map ./stampMap.json --reason 'release'",
    ],
  },
];
