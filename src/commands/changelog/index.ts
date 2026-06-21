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
import { writeJson, exitWithError, failWith } from "../../output/json.js";
import { resolveDate } from "../../dates.js";

type Row = Record<string, unknown>;

const TYPES = ["feature", "improvement", "bugfix"];
const AREAS = ["frontend", "backend", "cli", "database", "cicd"];
const BUMP_LEVELS = ["none", "patch", "minor", "major"];
const LANGUAGES = ["fi", "en"]; // devChangelog.language is CHAR(2) NOT NULL DEFAULT 'fi'

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

export async function runChangelogList(client: ApiClient, opts: Record<string, string | number | undefined>): Promise<ListEnvelope<Row>> {
  if (typeof opts.sentry === "string") opts.sentry = normalizeSentryRef(opts.sentry);
  const p = new URLSearchParams();
  // CLI option key → API query key. The --feedback flag maps to the backend's
  // `feedbackId` filter (controller passes req.query straight to listEntries).
  const keyMap: Record<string, string> = {
    month: "month", type: "type", area: "area", repo: "repo", feedback: "feedbackId",
    sentry: "sentryIssue", limit: "limit",
  };
  for (const [optKey, apiKey] of Object.entries(keyMap)) {
    if (opts[optKey] !== undefined) p.set(apiKey, String(opts[optKey]));
  }
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

function validateEnums(type?: string, area?: string, bumpLevel?: string): void {
  if (type !== undefined && !TYPES.includes(type))
    failWith(`--type must be ${TYPES.join("|")}`, 4);
  if (area !== undefined && !AREAS.includes(area))
    failWith(`--area must be ${AREAS.join("|")}`, 4);
  if (bumpLevel !== undefined && !BUMP_LEVELS.includes(bumpLevel))
    failWith(`--bump-level must be ${BUMP_LEVELS.join("|")}`, 4);
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
  getClient: () => Promise<ApiClient>
): void {
  const c = parent
    .command("changelog")
    .description(
      "Development changelog entries (source of the monthly report)"
    );

  addWriteFlagsToCommand(
    c
      .command("add")
      .description(
        "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row."
      )
      .requiredOption("--type <t>", "feature|improvement|bugfix")
      .requiredOption("--area <a>", "frontend|backend|cli|database|cicd")
      .requiredOption("--title <s>", "Entry title")
      .requiredOption("--description <s>", "Kuvaus")
      .option("--benefits <s>", "Hyödyt")
      .option("--impact <s>", "Vaikutus")
      .option("--status <s>", "Tila (Julkaistu/Korjattu/...)")
      .option("--severity <s>", "Bug severity")
      .option("--files <csv>", "Comma-separated file paths")
      .option("--repo <r>", "Repo/submodule")
      .option("--sha <csv>", "Commit SHAs (CSV)")
      .option("--vtag <s>", "Version tag")
      .option("--bump-level <l>", "App version bump this implies: none|patch|minor|major", "patch")
      .option("--feedback <id>", "cliFeedback id this resolves", Number)
      .option("--sentry <ref>", "Sentry issue short id or URL this fixes")
      .option("--date <d>", "Entry date (YYYY-MM-DD|today), default today")
      .option("--language <l>", "Entry language (fi|en), default fi")
  ).action(
    async (
      o: Record<string, string> & WriteFlags & { feedback?: number; vtag?: string; bumpLevel?: string }
    ) => {
      validateEnums(o.type, o.area, o.bumpLevel);
      const entryDate = resolveDate(o.date || "today")!;
      const body: ChangelogAddBody = {
        type: o.type,
        area: o.area,
        title: o.title,
        description: o.description,
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
      if (o.sha) body.commitShas = o.sha;
      if (o.vtag) body.versionTag = o.vtag;
      if (o.feedback !== undefined) body.feedbackId = Number(o.feedback);
      if (o.sentry) body.sentryIssue = normalizeSentryRef(o.sentry);
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
      "List change entries (filters: --month --type --area --repo --feedback --sentry --limit)"
    )
    .option("--month <YYYY-MM>", "Filter to a month")
    .option("--type <t>", "feature|improvement|bugfix")
    .option("--area <a>", "frontend|backend|cli|database|cicd")
    .option("--repo <r>", "Repo/submodule")
    .option("--feedback <id>", "Entries linked to a feedback id", Number)
    .option("--sentry <ref>", "Entries linked to a Sentry issue short id")
    .option("--limit <n>", "Max rows", Number)
    .action(async (o: Record<string, string | number>) => {
      try {
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
      .command("update <changelogId>")
      .description("Edit an entry")
      .option("--type <t>", "feature|improvement|bugfix")
      .option("--area <a>", "frontend|backend|cli|database|cicd")
      .option("--title <s>", "New title")
      .option("--description <s>", "New description")
      .option("--benefits <s>", "Hyödyt")
      .option("--impact <s>", "Vaikutus")
      .option("--status <s>", "Status update (e.g. mark deployed)")
      .option("--severity <s>", "Bug severity")
      .option("--files <csv>", "Comma-separated file paths")
      .option("--repo <r>", "Repo/submodule")
      .option("--sha <csv>", "Commit SHAs (CSV)")
      .option("--vtag <s>", "Version tag")
      .option("--date <d>", "Entry date (YYYY-MM-DD|today)")
      .option("--language <l>", "Entry language (fi|en)")
  ).action(async (id: string, o: Record<string, string> & WriteFlags & { vtag?: string }) => {
    validateEnums(o.type, o.area);
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
    .requiredOption("--month <YYYY-MM>", "Month to render")
    .option("--format <f>", "md|json", "md")
    .action(async (o: { month: string; format: string }) => {
      if (!/^\d{4}-\d{2}$/.test(o.month))
        failWith("--month must be YYYY-MM", 4);
      try {
        writeJson(
          await runChangelogReport(await getClient(), o.month, o.format)
        );
      } catch (e) {
        exitWithError(e);
      }
    });

  c.command("pending")
    .description(
      "Unreleased entries (versionTag IS NULL) + the max bump level they imply. Drives the deploy-time app version bump."
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
        "Stamp all currently-unreleased entries with a version tag (marks them released). Called by the deploy step after a successful version bump."
      )
      .requiredOption("--vtag <v>", "Version tag to stamp (e.g. 1.0.8)")
  ).action(async (o: WriteFlags & { vtag: string }) => {
    try {
      writeJson(await runChangelogRelease(await getClient(), o.vtag, o));
    } catch (e) {
      exitWithError(e);
    }
  });
}

export const CHANGELOG_SPECS: CommandSpec[] = [
  {
    command: "ib changelog add",
    description:
      "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row.",
    auth: "any",
    tier: "developer",
    args: [],
    flags: [
      {
        name: "type",
        type: "string",
        required: true,
        description: "feature|improvement|bugfix",
      },
      {
        name: "area",
        type: "string",
        required: true,
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
        required: true,
        description: "Kuvaus",
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
      { name: "repo", type: "string", description: "Repo/submodule" },
      { name: "sha", type: "string", description: "Commit SHAs (CSV)" },
      { name: "vtag", type: "string", description: "Version tag" },
      { name: "bump-level", type: "string", default: "patch", description: "App version bump this implies: none|patch|minor|major" },
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
        name: "date",
        type: "date",
        description: "Entry date (YYYY-MM-DD|today)",
      },
      { name: "language", type: "string", description: "Entry language (fi|en), default fi" },
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
      "--dry-run is SERVER-side (X-Dry-Run): the backend validates the payload then echoes wouldCreate without inserting — a bad --type/--area/--date still 400s under --dry-run.",
      "Developer-gated.",
    ],
    seeAlso: ["ib changelog report", "ib feedback resolve"],
    examples: [
      'ib changelog add --type bugfix --area cli --title "x" --description "y" --feedback 12 --sha 59d9cc5',
      'ib changelog add --type bugfix --area backend --title "fix npe" --description "y" --sentry PUMINET5API-1A2',
    ],
  },
  {
    command: "ib changelog list",
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
      { name: "limit", type: "number", description: "Max rows" },
    ],
    outputShape: "ListEnvelope<entry>",
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
    ],
    examples: ["ib changelog list --month 2026-06 --type feature"],
  },
  {
    command: "ib changelog get",
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
        remedy: "ib changelog list",
      },
    ],
    examples: ["ib changelog get 7"],
  },
  {
    command: "ib changelog update",
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
        description: "feature|improvement|bugfix",
      },
      {
        name: "area",
        type: "string",
        description: "frontend|backend|cli|database|cicd",
      },
      { name: "title", type: "string", description: "New title" },
      { name: "description", type: "string", description: "New description" },
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
      { name: "vtag", type: "string", description: "Version tag" },
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
      'ib changelog update 7 --status "Deployed prod"',
      "ib changelog update 386 --language en",
    ],
  },
  {
    command: "ib changelog report",
    description:
      "Generate the monthly report (markdown or json) from entries.",
    auth: "any",
    tier: "developer",
    flags: [
      {
        name: "month",
        type: "string",
        required: true,
        description: "YYYY-MM",
      },
      {
        name: "format",
        type: "string",
        default: "md",
        description: "md|json",
      },
    ],
    outputShape: "{ month, markdown } | { month, rows }",
    errors: [
      {
        http: 403,
        exit: 3,
        meaning: "Developer only",
        remedy: "dev token",
      },
    ],
    examples: ["ib changelog report --month 2026-06"],
  },
  {
    command: "ib changelog pending",
    description:
      "Unreleased entries (versionTag IS NULL) + the max bump level they imply. Drives the deploy-time app version bump.",
    auth: "any",
    tier: "developer",
    flags: [],
    outputShape: "{ entries, maxBumpLevel, count }",
    errors: [{ http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" }],
    examples: ["ib changelog pending"],
  },
  {
    command: "ib changelog release",
    description:
      "Stamp all currently-unreleased entries with a version tag (marks them released).",
    auth: "any",
    tier: "developer",
    flags: [{ name: "vtag", type: "string", required: true, description: "Version tag to stamp (e.g. 1.0.8)" }],
    writeFlags: true,
    mutates: true,
    outputShape: "{ released, versionTag } | { dryRun, wouldRelease }",
    errors: [
      { http: 403, exit: 3, meaning: "Developer only", remedy: "dev token" },
      { http: 400, exit: 4, meaning: "Validation (missing versionTag)", remedy: "pass --vtag" },
    ],
    notes: ["Developer-gated.", "Typically invoked by scripts/apply-release-version.ps1, not by hand."],
    examples: ["ib changelog release --vtag 1.0.8 --reason 'release 1.0.8'"],
  },
];
