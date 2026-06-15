/**
 * `ib changelog` — development changelog entry management.
 *
 * Entries are the authoritative source for the monthly report.
 * Each entry records a feature, improvement, or bugfix with metadata
 * (type, area, files, commit SHAs, linked cliFeedback id, etc.).
 *
 * Commands:
 *   add      POST   /api/changelog   (developer-only; --dry-run is client-side)
 *   list     GET    /api/changelog   (filtered; developer-only)
 *   get      GET    /api/changelog/:id
 *   update   PUT    /api/changelog/:id  (developer-only)
 *   report   GET    /api/changelog/report?month=&format=  (developer-only)
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
  feedbackId?: number;
  sentryIssue?: string;
}

/**
 * POST /api/changelog. --dry-run is CLIENT-side (no server X-Dry-Run guard).
 */
export async function runChangelogAdd(
  client: ApiClient,
  body: ChangelogAddBody,
  flags: WriteFlags
): Promise<unknown> {
  if (flags.dryRun) return { dryRun: true, wouldAdd: body };
  return client.post<unknown>("/api/changelog", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export async function runChangelogList(client: ApiClient, opts: Record<string, string | number | undefined>): Promise<ListEnvelope<Row>> {
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

function validateEnums(type?: string, area?: string): void {
  if (type !== undefined && !TYPES.includes(type))
    failWith(`--type must be ${TYPES.join("|")}`, 4);
  if (area !== undefined && !AREAS.includes(area))
    failWith(`--area must be ${AREAS.join("|")}`, 4);
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
      .option("--feedback <id>", "cliFeedback id this resolves", Number)
      .option("--sentry <ref>", "Sentry issue short id or URL this fixes")
      .option("--date <d>", "Entry date (YYYY-MM-DD|today), default today")
  ).action(
    async (
      o: Record<string, string> & WriteFlags & { feedback?: number; vtag?: string }
    ) => {
      validateEnums(o.type, o.area);
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
}

export const CHANGELOG_SPECS: CommandSpec[] = [
  {
    command: "ib changelog add",
    description:
      "Add a change entry (feature|improvement|bugfix). The monthly report is generated from these. --feedback <id> auto-resolves that cliFeedback row.",
    auth: "any",
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
    ],
    writeFlags: true,
    mutates: true,
    outputShape: "{ changelogId } | { dryRun, wouldAdd }",
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
      "--dry-run is CLIENT-side (no server X-Dry-Run guard).",
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
    ],
    examples: ['ib changelog update 7 --status "Deployed prod"'],
  },
  {
    command: "ib changelog report",
    description:
      "Generate the monthly report (markdown or json) from entries.",
    auth: "any",
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
];
