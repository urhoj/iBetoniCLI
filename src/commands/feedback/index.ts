/**
 * `ib feedback` — file and triage CLI improvement proposals / trouble reports.
 *
 * When an AI (or CI) hits friction using `ib`, it files a freetext note here so
 * the CLI can be improved. Submission is QUIET (no GitHub issue, no spam to you
 * or the user — distinct from `bugReport`); the maintainer gets a private
 * heads-up email. A developer-gated analyzer skill reads them back via
 * `ib dev feedback list` and closes the loop.
 *
 * `create` is sent as a META request → exempt from the read-only write-lock, so
 * an agent running `--read-only` can still report friction. `list`/`get`/`resolve`
 * are developer-only; `resolve` is a real write (blocked under read-only).
 * `--dry-run` (create + resolve) resolves CLIENT-SIDE: prints the payload, no send.
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { readJsonObjectInput } from "../../api/parseBody.js";
import { failWith, writeJson } from "../../output/json.js";
import { assertEnum, parseRefId } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";

const KINDS = ["improvement", "bug", "idea", "legal"] as const;
type Kind = (typeof KINDS)[number];
const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"] as const;
type Scope = (typeof SCOPES)[number];
const STATUSES = ["open", "reviewed", "applied", "dismissed"] as const;
const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const;
type Severity = (typeof SEVERITIES)[number];

// complexity = an AI-agent triage estimate (1-5), orthogonal to severity
// (severity = urgency/impact; complexity = effort + how autonomously an agent
// can act). 1 simple/autonomous · 2 simple/wants-input-proceeds-on-recommendation
// · 3 complex/autonomous · 4 complex/needs-user · 5 very-complex/needs-user +
// heavier model (opus/fable). See `ib help complexity`.
const COMPLEXITY_MIN = 1;
const COMPLEXITY_MAX = 5;

/** Coerce+validate a complexity estimate to an integer in [1,5]; else exit 4. */
function validateComplexity(value: unknown, flag = "--complexity"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < COMPLEXITY_MIN || n > COMPLEXITY_MAX) {
    failWith(`${flag} must be an integer ${COMPLEXITY_MIN}-${COMPLEXITY_MAX}`, 4);
  }
  return n;
}

const MAX_FREETEXT = 200;
const CAP = 200;
const TRUNCATED_FIELDS = ["description", "resolution", "errorText"] as const;
const TRUNCATE_HINT =
  "description/resolution truncated to 200 chars; ib dev feedback get <id> for full text";

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
  params: {
    status?: string;
    kind?: string;
    scope?: string;
    search?: string;
    complexity?: number;
    maxComplexity?: number;
    limit?: number;
    offset?: number;
    oldest?: boolean;
  }
): Promise<Record<string, unknown>[]> {
  const suffix = qs({
    status: params.status || undefined,
    kind: params.kind || undefined,
    scope: params.scope || undefined,
    search: params.search || undefined,
    complexity: params.complexity,
    maxComplexity: params.maxComplexity,
    limit: params.limit,
    offset: params.offset,
    // Oldest-first (FIFO) — the draining-loop order. Default (no flag) stays the
    // backend's newest-first, which suits human "what just broke" triage.
    orderBy: params.oldest ? "createdAt" : undefined,
    orderDirection: params.oldest ? "ASC" : undefined,
  });
  const rows = await client.get<Record<string, unknown>[]>(`/api/feedback${suffix}`);
  return Array.isArray(rows) ? rows : [];
}

export interface FeedbackCreateInput {
  description: string;
  kind?: string;
  scope?: string;
  command?: string;
  error?: string;
  severity?: string;
  complexity?: number;
  dryRun?: boolean;
}

/**
 * Resolve the create description from the positional or its --description /
 * --body aliases (--body is the gh/git convention an agent reaches for by
 * default, and already this CLI's free-text body flag on `message chat send` —
 * feedback #278). `--title` folds in as the description's first line (there is
 * no stored title column — gh-issue-style `--title X --description Y` habit,
 * feedback #240/#241).
 */
export function resolveFeedbackCreateDescription(input: {
  description?: string;
  descriptionFlag?: string;
  bodyFlag?: string;
  title?: string;
}): string {
  const positional = input.description?.trim();
  const given = [input.descriptionFlag, input.bodyFlag]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
  const flagged = given[0];
  if (new Set(given).size > 1 || (positional && flagged && positional !== flagged)) {
    failWith(
      "Provide the description once — positionally, with --description, or with --body; if several are given, they must match",
      4
    );
  }
  const title = input.title?.trim();
  const description = positional ?? flagged;
  if (!description) {
    if (title) return title;
    failWith("description is required", 4);
  }
  return title ? `${title}\n\n${description}` : description;
}

/** Flags that a `--from-json` object can also supply (drives explicit-flag detection). */
export const FROM_JSON_FIELDS = [
  "description", "body", "title", "kind", "scope", "command", "error", "severity", "complexity",
] as const;

/** Field set `create` accepts from a flag or a `--from-json` object. */
export interface FeedbackCreateFields {
  description?: string;
  body?: string;
  title?: string;
  kind?: string;
  scope?: string;
  command?: string;
  error?: string;
  severity?: string;
  complexity?: number;
}

/**
 * Merge a `--from-json` object with the CLI flags (fb#299).
 *
 * Precedence: an EXPLICITLY-typed flag wins, then the JSON object, then the
 * Commander default. That middle rung is why `explicit` is passed separately
 * from the raw opts — `--kind`/`--scope` declare defaults ("improvement"/"cli"),
 * so feeding the raw opts in would let a default the caller never typed silently
 * outrank a JSON-supplied value. Callers detect "actually typed" with
 * `cmd.getOptionValueSource(name) === "cli"` (same idiom as `keikka list`).
 */
export function mergeFeedbackCreateInput(
  json: Record<string, unknown>,
  explicit: FeedbackCreateFields,
  defaults: FeedbackCreateFields
): FeedbackCreateFields {
  const s = (k: string): string | undefined => json[k] as string | undefined;
  return {
    description: explicit.description ?? s("description"),
    body: explicit.body ?? s("body"),
    title: explicit.title ?? s("title"),
    kind: explicit.kind ?? s("kind") ?? defaults.kind,
    scope: explicit.scope ?? s("scope") ?? defaults.scope,
    command: explicit.command ?? s("command"),
    error: explicit.error ?? s("error"),
    severity: explicit.severity ?? s("severity"),
    complexity: explicit.complexity ?? (json.complexity as number | undefined),
  };
}

interface FeedbackCreateBody {
  kind: Kind;
  scope: Scope;
  description: string;
  command?: string;
  error?: string;
  severity?: Severity;
  complexity?: number;
  context?: { conversationId: number };
}

function buildCreateBody(input: FeedbackCreateInput): FeedbackCreateBody {
  const description = input.description?.trim();
  if (!description) {
    failWith("description is required", 4);
  }
  assertEnum(input.scope, SCOPES, "--scope");
  assertEnum(input.severity, SEVERITIES, "--severity");
  const body: FeedbackCreateBody = {
    kind: KINDS.includes(input.kind as Kind) ? (input.kind as Kind) : "improvement",
    scope: (input.scope as Scope) ?? "cli",
    description,
  };
  if (input.command) body.command = input.command;
  if (input.error) body.error = input.error;
  if (input.severity) body.severity = input.severity as Severity;
  if (input.complexity !== undefined) body.complexity = validateComplexity(input.complexity);
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
 * filter (every status). With NO selector the DEFAULT is the active bucket
 * (`open` + `reviewed`) — closed items (`applied`/`dismissed`) are hidden unless
 * you ask for them. `--all` = null (every status); `--unresolved` = open +
 * reviewed; `--status` = a single value or comma-separated list. The three
 * selectors are mutually exclusive; conflicting/unknown values exit 4.
 */
function resolveStatuses(opts: {
  status?: string;
  unresolved?: boolean;
  all?: boolean;
}): string[] | null {
  const selectors = [
    opts.all && "--all",
    opts.unresolved && "--unresolved",
    opts.status && "--status",
  ].filter(Boolean);
  if (selectors.length > 1) {
    failWith(`Use only one of ${selectors.join(", ")}`, 4);
  }
  if (opts.all) return null;
  if (opts.status) {
    const list = opts.status
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of list) {
      assertEnum(s, STATUSES, "--status");
    }
    if (list.length) return list;
  }
  // Default (and --unresolved): the active bucket. Closed items need --all/--status.
  return ["open", "reviewed"];
}

/**
 * GET /api/feedback — developer-only. Defaults to the active bucket
 * (`open` + `reviewed`); pass `--all` for every status or `--status`/`--unresolved`
 * to filter. One status is a single server-filtered GET; the default,
 * `--unresolved`, and a CSV `--status` fan out to one GET per status, merged
 * newest-first (or oldest-first under `--oldest`) and sliced [offset,
 * offset+limit) client-side. Long free-text is capped at 200 chars unless
 * `--full`.
 */
export async function runFeedbackList(
  client: ApiClient,
  opts: {
    status?: string;
    kind?: string;
    scope?: string;
    search?: string;
    complexity?: number;
    maxComplexity?: number;
    limit?: number;
    offset?: number;
    unresolved?: boolean;
    all?: boolean;
    full?: boolean;
    oldest?: boolean;
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
      search: opts.search,
      complexity: opts.complexity,
      maxComplexity: opts.maxComplexity,
      limit: opts.limit,
      offset: opts.offset,
      oldest: opts.oldest,
    });
  } else {
    const pages = await Promise.all(
      statuses.map((s) =>
        fetchRows(client, {
          status: s,
          kind: opts.kind,
          scope: opts.scope,
          search: opts.search,
          complexity: opts.complexity,
          maxComplexity: opts.maxComplexity,
          limit: CAP,
          oldest: opts.oldest,
        })
      )
    );
    if (pages.some((p) => p.length >= CAP)) truncated = true;
    // feedbackId is monotonic with createdAt, so it doubles as the merge key.
    // dir = +1 oldest-first (ASC), -1 newest-first (DESC, the default).
    const dir = opts.oldest ? 1 : -1;
    const merged = pages
      .flat()
      .sort((a, b) => dir * (Number(a.feedbackId) - Number(b.feedbackId)));
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
  const env = listEnvelope(items);
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
 * --note / --reason / --resolution are aliases for the same stored note. When a
 * caller passes more than one with DIFFERENT values — natural for an AI, since
 * --reason means the X-Action-Reason audit header on every other write command —
 * keep them all (joined), instead of silently dropping all but one (feedback #216).
 */
export function mergeNoteFlags(...values: Array<string | undefined>): string | undefined {
  const distinct = [...new Set(values.filter((v): v is string => v !== undefined))];
  return distinct.length ? distinct.join("\n\n") : undefined;
}

/**
 * PUT /api/feedback/:id — developer triage (status and/or resolution note).
 * A REAL write — blocked under --read-only (exit 3). `--dry-run` previews the
 * body client-side without sending.
 *
 * A note-only call (no --status) does NOT close the row — the name "resolve"
 * primes callers to assume it does, so when the row comes back still
 * open/reviewed the ack carries a `hint` naming the closing statuses
 * (feedback #270). An explicit `--status open|reviewed` is a deliberate
 * choice — no hint.
 */
export async function runFeedbackResolve(
  client: ApiClient,
  id: number,
  input: FeedbackResolveInput
): Promise<Record<string, unknown>> {
  assertEnum(input.status, STATUSES, "--status");
  if (input.status === undefined && input.note === undefined) {
    failWith("Provide --status and/or --note", 4);
  }
  const body: Record<string, unknown> = {};
  if (input.status !== undefined) body.status = input.status;
  if (input.note !== undefined) body.resolution = input.note;
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
  }
  const row = await client.put<Record<string, unknown>>(`/api/feedback/${id}`, body);
  const out = input.full ? { ...row } : compactAck(row);
  if (input.status === undefined && (row.status === "open" || row.status === "reviewed")) {
    out.hint = `status unchanged (${row.status}) - pass --status applied|dismissed to close`;
  }
  return out;
}

/** Project an updated row to the compact edit-ack fields (description capped). */
function compactUpdateAck(row: Record<string, unknown>): Record<string, unknown> {
  const ack: Record<string, unknown> = {};
  for (const k of ["feedbackId", "scope", "kind", "severity", "complexity", "updatedAt"]) {
    if (k in row) ack[k] = row[k];
  }
  if ("description" in row) ack.description = truncateField(row.description).value;
  return ack;
}

export interface FeedbackUpdateInput {
  scope?: string;
  kind?: string;
  severity?: string;
  complexity?: number;
  description?: string;
  dryRun?: boolean;
  full?: boolean;
}

/**
 * PUT /api/feedback/:id — developer edit of a filed row's classification
 * (scope/kind/severity) or description; the correction twin of `resolve`
 * (which sets status/note), same endpoint. A REAL write — blocked under
 * --read-only (exit 3). `--dry-run` previews the body client-side. Deploy-gated:
 * an older backend ignores these fields and 400s on a status-less body.
 */
export async function runFeedbackUpdate(
  client: ApiClient,
  id: number,
  input: FeedbackUpdateInput
): Promise<Record<string, unknown>> {
  assertEnum(input.scope, SCOPES, "--scope");
  assertEnum(input.kind, KINDS, "--kind");
  assertEnum(input.severity, SEVERITIES, "--severity");
  if (input.description !== undefined && !input.description.trim()) {
    failWith("--description must be non-empty", 4);
  }
  const body: Record<string, unknown> = {};
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.severity !== undefined) body.severity = input.severity;
  if (input.complexity !== undefined) body.complexity = validateComplexity(input.complexity);
  if (input.description !== undefined) body.description = input.description.trim();
  if (Object.keys(body).length === 0) {
    failWith(
      "Provide at least one of --scope / --kind / --severity / --complexity / --description",
      4
    );
  }
  if (input.dryRun) {
    return { dryRun: true, wouldSend: { method: "PUT", path: `/api/feedback/${id}`, body } };
  }
  const row = await client.put<Record<string, unknown>>(`/api/feedback/${id}`, body);
  return input.full ? row : compactUpdateAck(row);
}

/**
 * Register all `ib feedback` subcommands:
 *   create   POST /api/feedback   (any user; meta → read-only exempt)
 *   list     GET  /api/feedback   (developer-only)
 *   get      GET  /api/feedback/:id (developer-only)
 *   resolve  PUT  /api/feedback/:id (developer-only; status/note write)
 *   update   PUT  /api/feedback/:id (developer-only; scope/kind/severity/description edit)
 */
export function registerFeedbackCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const f = parent
    .command("feedback", { hidden: !!opts.hidden })
    .description("File & triage CLI improvement proposals / trouble reports");

  f.command("create [description]")
    // `add` — hidden alias: an agent fresh off `ib dev changelog add` (the lone
    // group using `add` to create a top-level entry) naturally types
    // `feedback add`; accept it instead of dead-ending on exit 4 (feedback #229).
    .alias("add")
    .option("--description <text>", "Alias for the positional description")
    .option("--body <text>", "Alias for --description (free text, not JSON); if several are given, they must match")
    .option(
      "--title <text>",
      "Optional title, folded into the description as its first line (no stored title column)"
    )
    .option("--kind <kind>", "improvement | bug | idea | legal", "improvement")
    .option(
      "--scope <scope>",
      "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other — product surface this feedback targets (impeccable = auto-piped design-hook findings)",
      "cli"
    )
    .option("--command <argv>", "The ib command/argv that triggered the friction")
    .option("--error <msg>", "Error message you hit, if any")
    .option("--severity <sev>", "critical | major | minor | cosmetic (optional; most useful for --kind bug)")
    .option(
      "--complexity <n>",
      "1-5 agent-triage estimate: 1 simple+autonomous · 2 simple+wants-input · 3 complex+autonomous · 4 complex+needs-user · 5 very-complex+needs-user & heavier model (see `ib help complexity`)",
      Number
    )
    .option(
      "--from-json <file>",
      "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Shell-safe: the only way to pass text containing quotes on Windows PowerShell."
    )
    .option("--dry-run", "Print the payload without sending (client-side)")
    .action(
      guarded(async (
        description: string | undefined,
        opts: {
          description?: string;
          body?: string;
          title?: string;
          kind?: string;
          scope?: string;
          command?: string;
          error?: string;
          severity?: string;
          complexity?: number;
          fromJson?: string;
          dryRun?: boolean;
        },
        cmd: Command
      ) => {
        // Only the flags the caller ACTUALLY typed outrank the JSON object —
        // see mergeFeedbackCreateInput (--kind/--scope carry defaults).
        const explicit: Record<string, unknown> = {};
        for (const k of FROM_JSON_FIELDS) {
          if (cmd.getOptionValueSource(k) === "cli") explicit[k] = (opts as Record<string, unknown>)[k];
        }
        const merged = mergeFeedbackCreateInput(
          opts.fromJson ? readJsonObjectInput(opts.fromJson) : {},
          explicit as FeedbackCreateFields,
          { kind: opts.kind, scope: opts.scope }
        );
        const client = await getClient();
        writeJson(
          await runFeedbackCreate(client, {
            description: resolveFeedbackCreateDescription({
              description,
              descriptionFlag: merged.description,
              bodyFlag: merged.body,
              title: merged.title,
            }),
            kind: merged.kind,
            scope: merged.scope,
            command: merged.command,
            error: merged.error,
            severity: merged.severity,
            complexity: merged.complexity,
            dryRun: opts.dryRun,
          })
        );
      })
    );

  f.command("list")
    .option("--status <status>", "open | reviewed | applied | dismissed (or a comma-separated list, e.g. open,reviewed)")
    .option("--unresolved", "Shortcut for --status open,reviewed (un-closed items) — same as the default")
    .option("--all", "Include every status (open,reviewed,applied,dismissed); overrides the open+reviewed default")
    .option("--full", "Return untruncated description/resolution (default: capped at 200 chars)")
    .option("--kind <kind>", "improvement | bug | idea | legal")
    .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
    .option("--search <text>", "Substring match over description/command/resolution/errorText (deploy-gated)")
    .option("--complexity <n>", "Only items with this exact complexity (1-5)", Number)
    .option("--max-complexity <n>", "Only items with complexity <= n — the autonomously-workable slice (deploy-gated)", Number)
    .option("--oldest", "Oldest-first (createdAt ASC) — FIFO drain order for the triage loop; default is newest-first")
    .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
    .option("--offset <n>", "Pagination offset", Number)
    .action(
      jsonAction(getClient, (client, opts: { status?: string; kind?: string; scope?: string; search?: string; complexity?: number; maxComplexity?: number; limit?: number; offset?: number; unresolved?: boolean; all?: boolean; full?: boolean; oldest?: boolean; }) =>
        runFeedbackList(client, opts)
      )
    );

  f.command("get <id>")
    .option("--full", "Accepted for cross-command consistency; get always returns the full row (no-op)")
    .action(
      guarded(async (idStr: string) => {
        const id = parseRefId(idStr, "feedback", "get");
        const client = await getClient();
        writeJson(await runWithSiblingHint(client, id, "changelog", () => runFeedbackGet(client, id)));
      })
    );

  f.command("resolve <id>")
    .option("--status <status>", "open | reviewed | applied | dismissed")
    .option("--note <text>", "Resolution note stored on the row")
    .option("--reason <text>", "Alias for --note — here it IS the stored note, NOT the X-Action-Reason audit header")
    .option("--resolution <text>", "Alias for --note (matches the output field name); distinct values across the three note flags are merged into one note")
    .option("--dry-run", "Print the update body without sending (client-side)")
    .option("--full", "Return the full updated row (default: a compact ack)")
    .action(
      guarded(async (
        idStr: string,
        opts: { status?: string; note?: string; reason?: string; resolution?: string; dryRun?: boolean; full?: boolean }
      ) => {
        const id = parseRefId(idStr, "feedback", "resolve");
        const client = await getClient();
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () =>
            runFeedbackResolve(client, id, {
              status: opts.status,
              note: mergeNoteFlags(opts.note, opts.resolution, opts.reason),
              dryRun: opts.dryRun,
              full: opts.full,
            })
          )
        );
      })
    );

  f.command("update <id>")
    .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
    .option("--kind <kind>", "improvement | bug | idea | legal")
    .option("--severity <sev>", "critical | major | minor | cosmetic")
    .option("--complexity <n>", "1-5 agent-triage estimate — promote/downgrade after investigation (see `ib help complexity`)", Number)
    .option("--description <text>", "Replace the freetext description")
    .option("--body <text>", "Alias for --description (free text, not JSON); if both are given, they must match")
    .option("--dry-run", "Print the update body without sending (client-side)")
    .option("--full", "Return the full updated row (default: a compact ack)")
    .action(
      guarded(async (
        idStr: string,
        opts: {
          scope?: string;
          kind?: string;
          severity?: string;
          complexity?: number;
          description?: string;
          body?: string;
          dryRun?: boolean;
          full?: boolean;
        }
      ) => {
        const id = parseRefId(idStr, "feedback", "update");
        // --body is an alias for --description (feedback #278); fold it in so
        // runFeedbackUpdate sees one field. Both only when they agree.
        if (opts.body !== undefined) {
          if (opts.description !== undefined && opts.description.trim() !== opts.body.trim())
            failWith(
              "Provide the description via --description or --body, not both with different values",
              4
            );
          if (opts.description === undefined) opts.description = opts.body;
        }
        const client = await getClient();
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () => runFeedbackUpdate(client, id, opts))
        );
      })
    );

  f.command("count")
    .option("--kind <kind>", "improvement | bug | idea | legal")
    .option("--scope <scope>", "cli | app | jerry | bsg2 | workspace | security | ops | impeccable | other")
    .action(
      jsonAction(getClient, (client, opts: { kind?: string; scope?: string }) =>
        runFeedbackCount(client, opts)
      )
    );
}
