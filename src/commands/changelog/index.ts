/**
 * `ib changelog` — development changelog entry management.
 *
 * Entries are the authoritative source for the monthly report.
 * Each entry records a feature, improvement, or bugfix with metadata
 * (type, area, files, commit SHAs, linked cliFeedback id, etc.).
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
import type { ListEnvelope } from "../../api/envelopes.js";
import type { CommandSpec } from "../../output/help.js";
import {
  type WriteFlags,
  writeFlagsToHeaders,
  addWriteFlagsToCommand,
} from "../../api/writeFlags.js";
import { readFileSync } from "node:fs";
import { writeJson, exitWithError, failWith, failValidation } from "../../output/json.js";
import type { FlagProblem } from "../../output/validationEnvelope.js";
import { resolveDate } from "../../dates.js";

export function readJsonInput(path: string): unknown {
  const raw = (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

type Row = Record<string, unknown>;

const TYPES = ["feature", "improvement", "bugfix"];
const AREAS = ["frontend", "backend", "cli", "database", "cicd"];
const BUMP_LEVELS = ["none", "patch", "minor", "major"];
const LANGUAGES = ["fi", "en"]; // devChangelog.language is CHAR(2) NOT NULL DEFAULT 'en'
const SOURCES = ["human", "routine"];

/**
 * The repos whose versions `npm run deploy` Step 0 bumps independently, each
 * from the max --bump-level across the unreleased entries that name it. A
 * --repo value NOT in this set is unknown to Step 0 and triggers a fail-safe
 * bump of EVERY coordinated repo (unless --bump-level none). The standalone
 * lane (betonicli, @ibetoni/*) versions separately via `npm run final`, so
 * target those with `--repo <name> --bump-level none`.
 */
const COORDINATED_REPOS = [
  "puminet4",
  "puminet5api",
  "puminet7-functions-app",
  "betonijerry",
  "workspace",
];
const REPO_FLAG_DESC =
  "Repo this entry ships in — coordinated: puminet4|puminet5api|puminet7-functions-app|betonijerry|workspace. ⚠ An unrecognized value fail-safe-bumps ALL coordinated repos on next deploy; for the standalone lane (betonicli, @ibetoni/*) also pass --bump-level none.";

/**
 * Normalize a Sentry issue reference: accept a bare short id (e.g. PUMINET5API-1A2)
 * or extract one from a pasted URL/string; otherwise trim and cap at 64 chars to fit
 * the devChangelog.sentryIssue column. Store-only — never sent to Sentry.
 */
export function normalizeSentryRef(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/[A-Z0-9]{2,}-[A-Z0-9]+/);
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
  feedbackId?: number;
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

export async function runChangelogList(client: ApiClient, opts: Record<string, string | number | boolean | undefined>): Promise<ListEnvelope<Row>> {
  if (typeof opts.sentry === "string") opts.sentry = normalizeSentryRef(opts.sentry);
  const p = new URLSearchParams();
  // CLI option key → API query key. --feedback maps to the backend's `feedbackId`
  // filter; --search/--status are substring LIKE filters (the controller passes
  // req.query straight to listEntries). --has-feedback/--has-sentry are handled below.
  const keyMap: Record<string, string> = {
    month: "month", type: "type", area: "area", repo: "repo", feedback: "feedbackId",
    sentry: "sentryIssue", source: "source", search: "search", status: "status", limit: "limit",
  };
  for (const [optKey, apiKey] of Object.entries(keyMap)) {
    if (opts[optKey] !== undefined) p.set(apiKey, String(opts[optKey]));
  }
  if (opts.hasFeedback) p.set("hasFeedback", "1");
  if (opts.hasSentry) p.set("hasSentry", "1");
  const qs = p.toString();
  const rows = await client.get<Row[]>(`/api/changelog${qs ? `?${qs}` : ""}`);
  const items = Array.isArray(rows) ? rows : [];
  return { items, nextCursor: null, count: items.length };
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
  return client.get<Row>(
    `/api/changelog/report?month=${month}&format=${format}`
  );
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
  commandPath = "ib dev changelog add"
): void {
  const problems: FlagProblem[] = [];
  if (type !== undefined && !TYPES.includes(type))
    problems.push({ flag: "--type", issue: "invalid", got: type, allowed: TYPES, synonyms: TYPE_SYNONYMS });
  if (area !== undefined && !AREAS.includes(area))
    problems.push({ flag: "--area", issue: "invalid", got: area, allowed: AREAS });
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
const FIELD_MAX_LENGTHS: Record<string, number> = {
  title: 300,
  impact: 500,
  status: 30,
  severity: 20,
  repo: 200,
  sha: 500,
  vtag: 200,
};

/**
 * Reject over-length free-text flags BEFORE POSTing so they exit 4 (validation)
 * naming each flag + its cap + the actual length, instead of the backend 500ing
 * on "String or binary data would be truncated" (feedback #206). Every offending
 * flag is reported together (aggregated) so the caller fixes them in one re-run.
 * Shared by `add` and `update` (identical flag names). Exits 4; returns void.
 */
export function validateFieldLengths(o: Record<string, unknown>): void {
  const over: string[] = [];
  for (const [flag, cap] of Object.entries(FIELD_MAX_LENGTHS)) {
    const v = o[flag];
    if (typeof v === "string" && v.length > cap)
      over.push(`--${flag} is ${v.length} chars (max ${cap})`);
  }
  if (over.length)
    failWith(
      `value too long — ${over.join("; ")}; shorten to fit the devChangelog column`,
      4
    );
}

/**
 * Resolve the entry description from the positional, the --description alias, OR
 * the --summary alias (mirrors `ib dev feedback create` — feedback #172/#205;
 * "summary" is the word an AI reaches for naturally for the entry body). All
 * three are equivalent; exactly one value is required, and if several are given
 * they must agree. Exits 4 on conflict or absence.
 */
export function resolveChangelogDescription(positional?: string, flag?: string, summary?: string): string {
  const given = [positional, flag, summary]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  if (new Set(given).size > 1)
    failWith("Provide the description once — via the positional, --description, or --summary; if several are given they must match", 4);
  const description = given[0];
  if (!description) failWith("--description (or --summary, or a positional description) is required", 4);
  return description;
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

/** Normalize --language to a validated lowercase fi|en, or undefined when not passed. Exits 4 on a bad code. */
export function normalizeLanguage(lang?: string): string | undefined {
  if (lang === undefined) return undefined;
  const v = lang.trim().toLowerCase();
  if (!LANGUAGES.includes(v)) failWith(`--language must be ${LANGUAGES.join("|")}`, 4);
  return v;
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
      .description(
        "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row."
      )
      .requiredOption("--type <t>", "feature|improvement|bugfix (accepts fix→bugfix, feat→feature)")
      .requiredOption("--area <a>", "frontend|backend|cli|database|cicd")
      .requiredOption("--title <s>", "Entry title")
      .option("--description <s>", "Kuvaus — alias for the positional; if both are given, they must match")
      .option("--summary <s>", "Alias for --description (the entry body); if both are given, they must match")
      .option("--benefits <s>", "Hyödyt")
      .option("--impact <s>", "Vaikutus")
      .option("--status <s>", "Tila (Julkaistu/Korjattu/...)")
      .option("--severity <s>", "Bug severity")
      .option("--files <csv>", "Comma-separated file paths")
      .option("--repo <r>", REPO_FLAG_DESC)
      .option("--sha <csv>", "Commit SHAs (CSV)")
      .option("--commit <csv>", "Alias for --sha — Commit SHAs (CSV); if both are given, they must match")
      .option("--vtag <s>", "Version tag")
      .option("--bump-level <l>", "App version bump this implies: none|patch|minor|major", "patch")
      .option("--feedback <id>", "cliFeedback id this resolves", Number)
      .option("--sentry <ref>", "Sentry issue short id or URL this fixes")
      .option("--source <s>", "Source: human|routine (default: human)")
      .option("--date <d>", "Entry date (YYYY-MM-DD|today), default today")
      .option("--language <l>", "Entry language (fi|en), default en")
  ).action(
    async (
      description: string | undefined,
      o: Record<string, string> & WriteFlags & { feedback?: number; vtag?: string; bumpLevel?: string }
    ) => {
      o.type = normalizeType(o.type)!;
      validateEnums(o.type, o.area, o.bumpLevel, o.source);
      o.sha = resolveShaAlias(o.sha, o.commit)!;
      validateFieldLengths(o);
      const entryDate = resolveDate(o.date || "today")!;
      const body: ChangelogAddBody = {
        type: o.type,
        area: o.area,
        title: o.title,
        description: resolveChangelogDescription(description, o.description, o.summary),
        entryDate,
      };
      if (o.benefits) body.benefits = o.benefits;
      if (o.impact) body.impact = o.impact;
      if (o.status) body.status = o.status;
      if (o.severity) body.severity = o.severity;
      if (o.files)
        body.files = JSON.stringify(
          o.files
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        );
      if (o.repo) body.repo = o.repo;
      if (
        o.repo &&
        !COORDINATED_REPOS.includes(o.repo) &&
        (o.bumpLevel || "patch") !== "none"
      )
        console.error(
          `[ib] ⚠ --repo "${o.repo}" is not a coordinated repo (${COORDINATED_REPOS.join(
            ", "
          )}) — on next deploy this fail-safe-bumps ALL of them. For the standalone lane (betonicli, @ibetoni/*) add --bump-level none.`
        );
      if (o.sha) body.commitShas = o.sha;
      if (o.vtag) body.versionTag = o.vtag;
      if (o.feedback !== undefined) body.feedbackId = Number(o.feedback);
      if (o.sentry) body.sentryIssue = normalizeSentryRef(o.sentry);
      if (o.source) body.source = o.source;
      const addLang = normalizeLanguage(o.language);
      if (addLang) body.language = addLang;
      body.bumpLevel = o.bumpLevel || "patch";
      try {
        writeJson(await runChangelogAdd(await getClient(), body, o));
      } catch (e) {
        exitWithError(e);
      }
    }
  );

  c.command("list")
    .description(
      "List change entries (filters: --month --type --area --repo --feedback --sentry --source --search --status --has-feedback --has-sentry --limit)"
    )
    .option("--month <YYYY-MM>", "Filter to a month")
    .option("--type <t>", "feature|improvement|bugfix")
    .option("--area <a>", "frontend|backend|cli|database|cicd")
    .option("--repo <r>", "Repo/submodule")
    .option("--feedback <id>", "Entries linked to a feedback id", Number)
    .option("--sentry <ref>", "Entries linked to a Sentry issue short id")
    .option("--source <s>", "human|routine")
    .option("--search <text>", "Substring match over title/description/files/commitShas (deploy-gated)")
    .option("--status <substr>", "Substring match on the free-text status field, e.g. 'Deployed' (deploy-gated)")
    .option("--has-feedback", "Only entries linked to a feedback id (deploy-gated)")
    .option("--has-sentry", "Only entries linked to a Sentry issue (deploy-gated)")
    .option("--unreleased", "List only UNRELEASED/pending entries (versionTag IS NULL) staged for the next release, + the max bump level — routes to `changelog pending`")
    .option("--pending", "Alias for --unreleased")
    .option("--limit <n>", "Max rows", Number)
    .action(async (o: Record<string, string | number | boolean>) => {
      try {
        // --unreleased/--pending is the pending-queue view, not a month filter;
        // route it to the dedicated endpoint so the literal command an agent
        // reaches for works (feedback #196/#197).
        if (o.unreleased || o.pending) {
          writeJson(await runChangelogPending(await getClient()));
          return;
        }
        writeJson(await runChangelogList(await getClient(), o));
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("get <changelogId>")
    .description("Get one entry")
    .action(async (id: string) => {
      try {
        writeJson(await runChangelogGet(await getClient(), Number(id)));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    c
      .command("delete <changelogId>")
      .description(
        "Soft-delete an entry (sets isDeleted=1; retained for audit but hidden from all reads, no CLI undelete). Use to retract a mistaken/test entry."
      )
  ).action(async (id: string, o: WriteFlags) => {
    try {
      writeJson(await runChangelogDelete(await getClient(), Number(id), o));
    } catch (e) {
      exitWithError(e);
    }
  });

  addWriteFlagsToCommand(
    c
      .command("update <changelogId>")
      .description("Edit an entry")
      .option("--type <t>", "feature|improvement|bugfix (accepts fix→bugfix, feat→feature)")
      .option("--area <a>", "frontend|backend|cli|database|cicd")
      .option("--title <s>", "New title")
      .option("--description <s>", "New description")
      .option("--summary <s>", "Alias for --description; if both are given, they must match")
      .option("--benefits <s>", "Hyödyt")
      .option("--impact <s>", "Vaikutus")
      .option("--status <s>", "Status update (e.g. mark deployed)")
      .option("--severity <s>", "Bug severity")
      .option("--files <csv>", "Comma-separated file paths")
      .option("--repo <r>", "Repo/submodule")
      .option("--sha <csv>", "Commit SHAs (CSV)")
      .option("--commit <csv>", "Alias for --sha — Commit SHAs (CSV); if both are given, they must match")
      .option("--vtag <s>", "Version tag")
      .option("--source <s>", "Source: human|routine")
      .option("--date <d>", "Entry date (YYYY-MM-DD|today)")
      .option("--language <l>", "Entry language (fi|en)")
  ).action(async (id: string, o: Record<string, string> & WriteFlags & { vtag?: string }) => {
    if (o.type !== undefined) o.type = normalizeType(o.type)!;
    validateEnums(o.type, o.area, undefined, o.source, "ib dev changelog update");
    // --summary is an alias for --description (feedback #205); fold it in before
    // the patch build so the loop below picks it up. Both may be given only when
    // they agree.
    if (o.summary !== undefined) {
      if (o.description !== undefined && o.description.trim() !== o.summary.trim())
        failWith("Provide the description via --description or --summary, not both with different values", 4);
      if (o.description === undefined) o.description = o.summary;
    }
    o.sha = resolveShaAlias(o.sha, o.commit)!;
    validateFieldLengths(o);
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
    if (o.files)
      patch.files = JSON.stringify(
        o.files
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    if (o.sha) patch.commitShas = o.sha;
    if (o.vtag) patch.versionTag = o.vtag;
    if (o.date) patch.entryDate = resolveDate(o.date)!;
    const updLang = normalizeLanguage(o.language);
    if (updLang) patch.language = updLang;
    try {
      writeJson(
        await runChangelogUpdate(await getClient(), Number(id), patch, o)
      );
    } catch (e) {
      exitWithError(e);
    }
  });

  c.command("report")
    .description(
      "Generate the monthly report from entries (markdown or json)"
    )
    .option("--month <YYYY-MM>", "Month to render")
    .option("--unreleased", "Report UNRELEASED/pending entries staged for the next release instead of a month — routes to `changelog pending`")
    .option("--pending", "Alias for --unreleased")
    .option("--format <f>", "md|json", "md")
    .action(async (o: { month?: string; unreleased?: boolean; pending?: boolean; format: string }) => {
      try {
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
        writeJson(
          await runChangelogReport(await getClient(), o.month, o.format)
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("pending")
    .description(
      "List PENDING/unreleased changelog entries (versionTag IS NULL) staged for the next release, + the max bump level they imply. Drives the deploy-time app version bump."
    )
    .action(async () => {
      try {
        writeJson(await runChangelogPending(await getClient()));
      } catch (e) {
        exitWithError(e);
      }
    });

  addWriteFlagsToCommand(
    c
      .command("release")
      .description(
        "Stamp unreleased entries with a version tag (marks them released). Called by scripts/apply-release-version.ps1. Use --vtag to stamp them all with one tag, or --map for precise per-entry repo@version tags."
      )
      .option("--vtag <v>", "Single version tag to stamp on every pending entry (e.g. 1.0.8)")
      .option("--map <file>", "JSON file (or - for stdin): [{changelogId, versionTag}] for precise per-entry stamping")
  ).action(async (o: WriteFlags & { vtag?: string; map?: string }) => {
    if ((o.vtag ? 1 : 0) + (o.map ? 1 : 0) !== 1) {
      failWith("provide exactly one of --vtag or --map", 4);
    }
    try {
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
    } catch (e) {
      exitWithError(e);
    }
  });
}

export const CHANGELOG_SPECS: CommandSpec[] = [
  {
    command: "ib dev changelog add",
    description:
      "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row.",
    auth: "any",
    tier: "developer",
    args: [{ name: "description", type: "string", description: "Kuvaus (or pass as --description) — free length, the column is nvarchar(max)" }],
    flags: [
      {
        name: "type",
        type: "string",
        required: true,
        allowed: TYPES,
        synonyms: TYPE_SYNONYMS,
        description: "feature|improvement|bugfix (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
      },
      {
        name: "area",
        type: "string",
        required: true,
        allowed: AREAS,
        description: "frontend|backend|cli|database|cicd",
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
        description: "Alias for the positional description; if both are passed, they must match",
      },
      {
        name: "summary",
        type: "string",
        description: "Alias for --description (the entry body); if both are passed, they must match",
      },
      { name: "benefits", type: "string", description: "Hyödyt" },
      { name: "impact", type: "string", description: "Vaikutus" },
      { name: "status", type: "string", description: "Tila (Julkaistu/Korjattu/...)" },
      {
        name: "severity",
        type: "string",
        description: "Bug severity (Kriittinen/Korkea/Normaali/Matala)",
      },
      { name: "files", type: "string", description: "CSV of file paths" },
      { name: "repo", type: "string", description: REPO_FLAG_DESC },
      { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
      { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
      { name: "vtag", type: "string", description: "Version tag" },
      { name: "bump-level", type: "string", default: "patch", allowed: BUMP_LEVELS, description: "App version bump this implies: none|patch|minor|major" },
      {
        name: "feedback",
        type: "number",
        description: "cliFeedback id this entry resolves",
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
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ changelogId } | { dryRun, wouldCreate, validation }",
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
        meaning: "Validation (bad enum/date)",
        remedy: "check --type/--area/--date",
      },
      {
        http: 401,
        exit: 2,
        meaning: "Token expired",
        remedy: "ib auth refresh",
      },
    ],
    notes: [
      "You can pass the description positionally, as --description, or as --summary (an alias) — if you pass more than one they must match (mirrors `ib dev feedback create`).",
      'A description starting with "-" is parsed as an option (exit 4) — put a bare `--` terminator before it: ib dev changelog add --type bugfix --area cli --title "x" -- "-5% render time". Everything after `--` is taken as positional text.',
      "--dry-run is SERVER-side (X-Dry-Run): the backend validates the payload then echoes wouldCreate without inserting — a bad --type/--area/--date still 400s under --dry-run.",
      "Bounded free-text flags are length-checked client-side (exit 4) before POSTing: --status ≤30, --severity ≤20, --title ≤300, --impact ≤500, --repo/--vtag ≤200, --sha ≤500. (--description/--benefits/--files are unbounded.)",
      "Developer-gated.",
    ],
    seeAlso: ["ib dev changelog report", "ib dev feedback resolve"],
    examples: [
      'ib dev changelog add --type bugfix --area cli --title "x" --description "y" --feedback 12 --sha 59d9cc5',
      'ib dev changelog add "positional description works too" --type bugfix --area cli --title "x"',
      'ib dev changelog add --type bugfix --area backend --title "fix npe" --description "y" --sentry PUMINET5API-1A2',
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
        description: "feature|improvement|bugfix",
      },
      {
        name: "area",
        type: "string",
        description: "frontend|backend|cli|database|cicd",
      },
      { name: "repo", type: "string", description: "Repo/submodule" },
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
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "ListEnvelope<entry> | (with --unreleased) { items, entries, maxBumpLevel, count }",
    errors: [
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
    description: "Get one change entry.",
    auth: "any",
    tier: "developer",
    args: [
      {
        name: "changelogId",
        type: "number",
        description: "Entry id",
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
        remedy: "ib dev changelog list",
      },
    ],
    examples: ["ib dev changelog get 7"],
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
        description: "Entry id",
      },
    ],
    flags: [
      {
        name: "type",
        type: "string",
        description: "feature|improvement|bugfix (conventional-commit synonyms accepted: fix→bugfix, feat→feature)",
      },
      {
        name: "area",
        type: "string",
        description: "frontend|backend|cli|database|cicd",
      },
      { name: "title", type: "string", description: "New title" },
      { name: "description", type: "string", description: "New description" },
      { name: "summary", type: "string", description: "Alias for --description; if both are passed, they must match" },
      { name: "benefits", type: "string", description: "Hyödyt" },
      { name: "impact", type: "string", description: "Vaikutus" },
      {
        name: "status",
        type: "string",
        description: "Status update (e.g. mark deployed)",
      },
      { name: "severity", type: "string", description: "Bug severity" },
      { name: "files", type: "string", description: "CSV of file paths" },
      { name: "repo", type: "string", description: "Repo/submodule" },
      { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
      { name: "commit", type: "string", description: "Alias for --sha — Commit SHAs (CSV); if both are given, they must match" },
      { name: "vtag", type: "string", description: "Version tag" },
      { name: "source", type: "string", description: "Source: human|routine" },
      {
        name: "date",
        type: "date",
        description: "Entry date (YYYY-MM-DD|today)",
      },
      { name: "language", type: "string", description: "Entry language (fi|en)" },
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "entry",
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
      {
        http: 400,
        exit: 4,
        meaning: "Validation (bad enum/language)",
        remedy: "language must be fi|en",
      },
    ],
    examples: [
      'ib dev changelog update 7 --status "Deployed prod"',
      "ib dev changelog update 386 --language en",
    ],
  },
  {
    command: "ib dev changelog delete",
    description:
      "Soft-delete a change entry (isDeleted=1; retained for audit, hidden from all reads, no CLI undelete).",
    auth: "any",
    tier: "developer",
    args: [{ name: "changelogId", type: "number", description: "Entry id" }],
    flags: [],
    writeFlags: true,
    mutates: true,
    outputShape: "{ deleted: true } | { dryRun, wouldDelete }",
    errors: [
      { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
      { http: 404, exit: 5, meaning: "Not found (or already deleted)", remedy: "ib dev changelog list" },
    ],
    notes: [
      "Soft-delete: sets isDeleted=1 — the row is kept for audit but hidden from every read (get/list/report/pending), and there is no CLI undelete.",
      "Deleting an already-released entry (one with a versionTag) removes it from that month's generated report.",
      "--dry-run resolves CLIENT-side (echoes wouldDelete, issues no DELETE); the backend route has no X-Dry-Run guard.",
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
    outputShape: "{ entries, maxBumpLevel, count }",
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
    mutates: true,
    outputShape: "{ released, versionTag } | { released, mode:'map' } | { dryRun, wouldRelease }",
    errors: [
      { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
      { http: 400, exit: 4, meaning: "Validation (need --vtag or --map)", remedy: "pass exactly one of --vtag/--map" },
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
