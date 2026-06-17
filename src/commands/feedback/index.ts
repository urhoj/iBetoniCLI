/**
 * `ib feedback` — file and triage CLI improvement proposals / trouble reports.
 *
 * When an AI (or CI) hits friction using `ib`, it files a freetext note here so
 * the CLI can be improved. Submission is QUIET (no GitHub issue, no spam to you
 * or the user — distinct from `bugReport`); the maintainer gets a private
 * heads-up email. A developer-gated analyzer skill reads them back via
 * `ib feedback list` and closes the loop.
 *
 * `create` is sent as a META request → exempt from the read-only write-lock, so
 * an agent running `--read-only` can still report friction. `list`/`get`/`resolve`
 * are developer-only; `resolve` is a real write (blocked under read-only).
 * `--dry-run` (create + resolve) resolves CLIENT-SIDE: prints the payload, no send.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { CliError } from "../../api/errors.js";
import type { ListEnvelope } from "../../api/envelopes.js";
import { writeJson, exitWithError } from "../../output/json.js";

const KINDS = ["improvement", "bug", "idea", "legal"] as const;
type Kind = (typeof KINDS)[number];
const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "other"] as const;
type Scope = (typeof SCOPES)[number];
const STATUSES = ["open", "reviewed", "applied", "dismissed"] as const;
type Status = (typeof STATUSES)[number];

const MAX_FREETEXT = 200;
const CAP = 200;
const TRUNCATED_FIELDS = ["description", "resolution", "errorText"] as const;
const TRUNCATE_HINT =
  "description/resolution truncated to 200 chars; ib feedback get <id> for full text";

/** Cap a string at MAX_FREETEXT chars, appending "..." when cut. Non-strings
 * pass through untouched. */
function truncateField(v: unknown): { value: unknown; cut: boolean } {
  if (typeof v === "string" && v.length > MAX_FREETEXT) {
    return { value: v.slice(0, MAX_FREETEXT) + "...", cut: true };
  }
  return { value: v, cut: false };
}

/** Shallow-copy a feedback row with its long free-text fields capped. */
function compactRow(
  row: Record<string, unknown>
): { row: Record<string, unknown>; cut: boolean } {
  const out = { ...row };
  let cut = false;
  for (const f of TRUNCATED_FIELDS) {
    if (f in out) {
      const t = truncateField(out[f]);
      out[f] = t.value;
      if (t.cut) cut = true;
    }
  }
  return { row: out, cut };
}

/** Build the query string and GET a page of feedback rows (always an array). */
async function fetchRows(
  client: ApiClient,
  params: { status?: string; kind?: string; scope?: string; limit?: number; offset?: number }
): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.kind) qs.set("kind", params.kind);
  if (params.scope) qs.set("scope", params.scope);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const rows = await client.get<Record<string, unknown>[]>(`/api/feedback${suffix}`);
  return Array.isArray(rows) ? rows : [];
}

export interface FeedbackCreateInput {
  description: string;
  kind?: string;
  scope?: string;
  command?: string;
  error?: string;
  dryRun?: boolean;
}

interface FeedbackCreateBody {
  kind: Kind;
  scope: Scope;
  description: string;
  command?: string;
  error?: string;
  context?: { conversationId: number };
}

function buildCreateBody(input: FeedbackCreateInput): FeedbackCreateBody {
  const description = input.description?.trim();
  if (!description) {
    throw new CliError("description is required", 400, null, 4);
  }
  if (input.scope !== undefined && !SCOPES.includes(input.scope as Scope)) {
    throw new CliError(`--scope must be one of: ${SCOPES.join(", ")}`, 400, null, 4);
  }
  const body: FeedbackCreateBody = {
    kind: KINDS.includes(input.kind as Kind) ? (input.kind as Kind) : "improvement",
    scope: (input.scope as Scope) ?? "cli",
    description,
  };
  if (input.command) body.command = input.command;
  if (input.error) body.error = input.error;
  const convId = Number(process.env.IB_CONVERSATION_ID);
  if (Number.isInteger(convId) && convId > 0) {
    body.context = { conversationId: convId };
  }
  return body;
}

/**
 * POST /api/feedback — file a proposal / trouble report. `meta: true` exempts it
 * from the read-only write-lock. `--dry-run` prints the payload and never POSTs.
 */
export async function runFeedbackCreate(
  client: ApiClient,
  input: FeedbackCreateInput
): Promise<Record<string, unknown>> {
  const body = buildCreateBody(input);
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "POST", path: "/api/feedback", body } };
  }
  return client.post<Record<string, unknown>>("/api/feedback", body, { meta: true });
}

/**
 * Resolve the requested status filter into a list of statuses, or null for no
 * filter. `--unresolved` = open + reviewed. `--status` may be a single value or
 * a comma-separated list. Conflicting/unknown values exit 4.
 */
function resolveStatuses(opts: { status?: string; unresolved?: boolean }): string[] | null {
  if (opts.unresolved && opts.status) {
    throw new CliError("Use either --unresolved or --status, not both", 400, null, 4);
  }
  if (opts.unresolved) return ["open", "reviewed"];
  if (opts.status) {
    const list = opts.status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of list) {
      if (!STATUSES.includes(s as Status)) {
        throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
      }
    }
    return list.length ? list : null;
  }
  return null;
}

/**
 * GET /api/feedback — developer-only. One status (or none) is a single
 * server-filtered GET. `--unresolved` / a CSV `--status` fan out to one GET per
 * status, merged newest-first and sliced [offset, offset+limit) client-side.
 * Long free-text is capped at 200 chars unless `--full`.
 */
export async function runFeedbackList(
  client: ApiClient,
  opts: {
    status?: string;
    kind?: string;
    scope?: string;
    limit?: number;
    offset?: number;
    unresolved?: boolean;
    full?: boolean;
  }
): Promise<ListEnvelope<Record<string, unknown>>> {
  const statuses = resolveStatuses(opts);
  let items: Record<string, unknown>[];
  let truncated = false;

  if (!statuses || statuses.length <= 1) {
    items = await fetchRows(client, {
      status: statuses?.[0],
      kind: opts.kind,
      scope: opts.scope,
      limit: opts.limit,
      offset: opts.offset,
    });
  } else {
    const pages = await Promise.all(
      statuses.map((s) =>
        fetchRows(client, { status: s, kind: opts.kind, scope: opts.scope, limit: CAP })
      )
    );
    if (pages.some((p) => p.length >= CAP)) truncated = true;
    const merged = pages
      .flat()
      .sort((a, b) => Number(b.feedbackId) - Number(a.feedbackId));
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    if (merged.length > offset + limit) truncated = true;
    items = merged.slice(offset, offset + limit);
  }

  let cut = false;
  if (!opts.full) {
    items = items.map((r) => {
      const c = compactRow(r);
      if (c.cut) cut = true;
      return c.row;
    });
  }
  const env: ListEnvelope<Record<string, unknown>> = {
    items,
    nextCursor: null,
    count: items.length,
  };
  if (truncated) env.truncated = true;
  if (cut) env.hint = TRUNCATE_HINT;
  return env;
}

/** GET /api/feedback/:id — developer-only single row. */
export async function runFeedbackGet(
  client: ApiClient,
  id: number
): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(`/api/feedback/${id}`);
}

/**
 * Client-side aggregate of /api/feedback for the cheapest "is there anything?"
 * answer. Fetches up to the 200-row cap (optionally pre-filtered by
 * kind/scope) and buckets by status/kind/scope. Flags `truncated` if the table
 * exceeds the cap (won't happen at current row counts; kept honest).
 */
export async function runFeedbackCount(
  client: ApiClient,
  opts: { kind?: string; scope?: string }
): Promise<Record<string, unknown>> {
  const rows = await fetchRows(client, { kind: opts.kind, scope: opts.scope, limit: CAP });
  const byStatus: Record<string, number> = { open: 0, reviewed: 0, applied: 0, dismissed: 0 };
  const byKind: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.status ?? "");
    if (s in byStatus) byStatus[s] += 1;
    const k = String(r.kind ?? "unknown");
    byKind[k] = (byKind[k] ?? 0) + 1;
    const sc = String(r.scope ?? "unknown");
    byScope[sc] = (byScope[sc] ?? 0) + 1;
  }
  const out: Record<string, unknown> = { total: rows.length, byStatus, byKind, byScope };
  if (rows.length >= CAP) {
    out.truncated = true;
    out.hint = "count is a lower bound — fetch hit the 200-row cap";
  }
  return out;
}

/** Project a resolved row to the compact write-ack fields (resolution capped). */
function compactAck(row: Record<string, unknown>): Record<string, unknown> {
  const ack: Record<string, unknown> = {};
  for (const k of ["feedbackId", "status", "updatedAt"]) {
    if (k in row) ack[k] = row[k];
  }
  if ("resolution" in row) ack.resolution = truncateField(row.resolution).value;
  return ack;
}

export interface FeedbackResolveInput {
  status?: string;
  note?: string;
  dryRun?: boolean;
  full?: boolean;
}

/**
 * PUT /api/feedback/:id — developer triage (status and/or resolution note).
 * A REAL write — blocked under --read-only (exit 3). `--dry-run` previews the
 * body client-side without sending.
 */
export async function runFeedbackResolve(
  client: ApiClient,
  id: number,
  input: FeedbackResolveInput
): Promise<Record<string, unknown>> {
  if (input.status !== undefined && !STATUSES.includes(input.status as Status)) {
    throw new CliError(`--status must be one of: ${STATUSES.join(", ")}`, 400, null, 4);
  }
  if (input.status === undefined && input.note === undefined) {
    throw new CliError("Provide --status and/or --note", 400, null, 4);
  }
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body.status = input.status;
  if (input.note !== undefined) body.resolution = input.note;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
  }
  const row = await client.put<Record<string, unknown>>(`/api/feedback/${id}`, body);
  return input.full ? row : compactAck(row);
}

/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; a real write)
 */
export function registerFeedbackCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>
): void {
  const f = parent
    .command("feedback")
    .description("File & triage CLI improvement proposals / trouble reports");

  f.command("create <description>")
    .description(
      "File a proposal/trouble report. Silent server-side; works under --read-only."
    )
    .option("--kind <kind>", "improvement | bug | idea | legal", "improvement")
    .option(
      "--scope <scope>",
      "cli | app | jerry | bsg2 | workspace | other — product surface this feedback targets",
      "cli"
    )
    .option("--command <argv>", "The ib command/argv that triggered the friction")
    .option("--error <msg>", "Error message you hit, if any")
    .option("--dry-run", "Print the payload without sending (client-side)")
    .action(
      async (
        description: string,
        opts: { kind?: string; scope?: string; command?: string; error?: string; dryRun?: boolean }
      ) => {
        try {
          const client = await getClient();
          writeJson(await runFeedbackCreate(client, { description, ...opts }));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  f.command("list")
    .description("List feedback for triage (developer-only)")
    .option("--status <status>", "open | reviewed | applied | dismissed")
    .option("--kind <kind>", "improvement | bug | idea | legal")
    .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | other")
    .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
    .option("--offset <n>", "Pagination offset", Number)
    .action(
      async (opts: { status?: string; kind?: string; scope?: string; limit?: number; offset?: number }) => {
        try {
          writeJson(await runFeedbackList(await getClient(), opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );

  f.command("get <id>")
    .description("Fetch one feedback row by id (developer-only)")
    .action(async (idStr: string) => {
      try {
        writeJson(await runFeedbackGet(await getClient(), Number(idStr)));
      } catch (e) {
        exitWithError(e);
      }
    });

  f.command("resolve <id>")
    .description(
      "Triage a feedback row: set status and/or note (developer-only; a write)"
    )
    .option("--status <status>", "open | reviewed | applied | dismissed")
    .option("--note <text>", "Resolution note stored on the row")
    .option("--dry-run", "Print the update body without sending (client-side)")
    .action(
      async (
        idStr: string,
        opts: { status?: string; note?: string; dryRun?: boolean }
      ) => {
        try {
          writeJson(await runFeedbackResolve(await getClient(), Number(idStr), opts));
        } catch (e) {
          exitWithError(e);
        }
      }
    );
}
