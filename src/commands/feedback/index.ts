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
import { failWith, writeJson } from "../../output/json.js";
import { assertEnum, assertEnumCsv, parseRefId } from "../../targets.js";
import { runWithSiblingHint } from "../../refHint.js";
import { guarded, jsonAction } from "../_shared/action.js";
import { foldAliases } from "../_shared/flags.js";
import { applyFromJson, type FromJsonConfig } from "../_shared/fromJson.js";
import { qs } from "../../api/query.js";

// Exported for specs.ts: the spec flags declare these as machine-readable
// `allowed:` sets (validation envelopes), single-sourced from here.
export const KINDS = ["improvement", "bug", "idea", "legal"] as const;
type Kind = (typeof KINDS)[number];
export const SCOPES = ["cli", "app", "jerry", "bsg2", "workspace", "security", "ops", "impeccable", "other"] as const;
type Scope = (typeof SCOPES)[number];
export const STATUSES = ["open", "reviewed", "applied", "dismissed"] as const;
export const SEVERITIES = ["critical", "major", "minor", "cosmetic"] as const;
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

/**
 * Emitted whenever a complexity filter is active, because that filter's blind
 * spot is invisible in its own result.
 *
 * `complexity` is optional on `create` and most filing paths (the friction
 * auto-capture included) never set it, so the column is mostly NULL — a
 * measured 176 of 200 scope=cli rows. NULL there means "nobody estimated", but
 * a `complexity <= n` predicate excludes it as if it meant "too hard", and
 * nothing in the envelope records the omission. The flag is documented as the
 * autonomously-workable slice a batch-fix agent pulls, so the failure lands
 * exactly where it hurts: a batch that returned 21 of ~40 real candidates looks
 * like a complete answer (feedback #362 — of the four items fixed in the run
 * that found this, three were NULL-complexity and genuinely 1-2, so trusting
 * the filter would have surfaced one of four and reported the batch done).
 */
const COMPLEXITY_NULL_HINT =
  "a complexity filter is active and EXCLUDES rows with no estimate (complexity is optional on create, so most rows are unset — absent means unestimated, not complex); re-run without --complexity/--max-complexity to see the full candidate set";

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
  const description = foldAliases(
    [input.description, input.descriptionFlag, input.bodyFlag],
    "Provide the description once — positionally, with --description, or with --body; if several are given, they must match"
  );
  const title = input.title?.trim();
  if (!description) {
    if (title) return title;
    failWith("description is required", 4);
  }
  return title ? `${title}\n\n${description}` : description;
}

/**
 * `create`'s `--from-json` config — the shared pipeline (_shared/fromJson.ts)
 * derives the accepted keys from the command's own registered flags, rejects
 * unknown/wrong-typed keys aggregated (exit 4 — the fb#298 silent-drop class is
 * gone), and merges explicit flag > JSON > Commander default (fb#299: --kind/
 * --scope declare defaults, which must not outrank a JSON-supplied value).
 *
 * readShapeAliases: `errorText` is what the READ commands emit for the --error
 * field, and templating a --from-json file off a row from `ib dev feedback get`
 * is the natural way to author one (feedback #357).
 */
const CREATE_FROM_JSON: FromJsonConfig = {
  nonPayload: new Set(["fromJson", "dryRun", "help"]),
  readShapeAliases: { errorText: "error" },
  numericFields: new Set(["complexity"]),
};

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
    assertEnumCsv(list, STATUSES, "--status");
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
  const hints: string[] = [];
  if (cut) hints.push(TRUNCATE_HINT);
  if (opts.complexity !== undefined || opts.maxComplexity !== undefined)
    hints.push(COMPLEXITY_NULL_HINT);
  if (hints.length) env.hint = hints.join("; ");
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
 * `resolve`'s `--from-json` config (feedback #327) — the shared pipeline with
 * no Commander defaults, so the precedence collapses to explicit flag > JSON.
 * The three note aliases (--note/--reason/--resolution) are merged AFTER the
 * per-key merge via {@link mergeNoteFlags}, so a note supplied in JSON and a
 * different one typed on argv are both kept, exactly as for three argv flags.
 * Unknown/wrong-typed JSON keys exit 4 (shared contract, fb#298 class).
 */
const RESOLVE_FROM_JSON: FromJsonConfig = {
  nonPayload: new Set(["fromJson", "dryRun", "full", "help"]),
};

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
  /** Text appended to the CURRENT description (read-merge-write) — never replaces it. */
  appendDescription?: string;
  dryRun?: boolean;
  full?: boolean;
}

/**
 * `update`'s `--from-json` config (feedback #332) — the shared pipeline with no
 * Commander defaults, so the precedence collapses to explicit flag > JSON.
 * `body` (JSON or argv) folds into `description` AFTER the merge via
 * {@link foldAliases}, mirroring `changelog update` — differing values across
 * the two spellings exit 4 instead of one silently winning. Unknown/wrong-typed
 * JSON keys exit 4 (shared contract, fb#298 class).
 */
const UPDATE_FROM_JSON: FromJsonConfig = {
  nonPayload: new Set(["fromJson", "dryRun", "full", "help"]),
  numericFields: new Set(["complexity"]),
};

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
  if (input.appendDescription !== undefined && !input.appendDescription.trim()) {
    failWith("--append-description must be non-empty", 4);
  }
  // Replace and append are opposite intents on the same field — accepting both
  // would silently pick one. Exit 4 rather than guess (mirrors the glossary
  // `--definition` vs `--append-definition` pairing).
  if (input.description !== undefined && input.appendDescription !== undefined) {
    failWith("--description and --append-description are mutually exclusive", 4);
  }
  const body: Record<string, unknown> = {};
  if (input.scope !== undefined) body.scope = input.scope;
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.severity !== undefined) body.severity = input.severity;
  if (input.complexity !== undefined) body.complexity = validateComplexity(input.complexity);
  if (input.description !== undefined) body.description = input.description.trim();
  // Read-merge-write: --description REPLACES the filed report, which is the
  // destructive half of feedback #332. Appending keeps the original text and
  // adds to it, so later commentary can never overwrite the evidence.
  if (input.appendDescription !== undefined) {
    const current = await runFeedbackGet(client, id);
    const existing = typeof current.description === "string" ? current.description : "";
    const addition = input.appendDescription.trim();
    body.description = existing ? `${existing.trimEnd()}\n\n${addition}` : addition;
  }
  if (Object.keys(body).length === 0) {
    failWith(
      "Provide at least one of --scope / --kind / --severity / --complexity / --description / --append-description",
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
        // Shared merge: only the flags the caller ACTUALLY typed outrank the
        // JSON object (--kind/--scope carry defaults, fb#299); unknown or
        // wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, CREATE_FROM_JSON);
        const client = await getClient();
        writeJson(
          await runFeedbackCreate(client, {
            description: resolveFeedbackCreateDescription({
              description,
              descriptionFlag: opts.description,
              bodyFlag: opts.body,
              title: opts.title,
            }),
            kind: opts.kind,
            scope: opts.scope,
            command: opts.command,
            error: opts.error,
            severity: opts.severity,
            complexity: opts.complexity,
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
    .option("--complexity <n>", "Only items with this exact complexity (1-5). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex.", Number)
    .option("--max-complexity <n>", "Only items with complexity <= n — the autonomously-workable slice (deploy-gated). ⚠ EXCLUDES rows with no estimate, which is most of the table — absent means unestimated, not complex.", Number)
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
    .option(
      "--from-json <file>",
      "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: status, note (or reason/resolution). Shell-safe: the only way to pass a note containing quotes on Windows PowerShell."
    )
    .option("--dry-run", "Print the update body without sending (client-side)")
    .option("--full", "Return the full updated row (default: a compact ack)")
    .action(
      guarded(async (
        idStr: string,
        opts: { status?: string; note?: string; reason?: string; resolution?: string; fromJson?: string; dryRun?: boolean; full?: boolean },
        cmd: Command
      ) => {
        const id = parseRefId(idStr, "feedback", "resolve");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #327); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, RESOLVE_FROM_JSON);
        const client = await getClient();
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () =>
            runFeedbackResolve(client, id, {
              status: opts.status,
              // The three note aliases merge AFTER the per-key merge, so a note
              // from JSON and a different one typed on argv are both kept.
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
    .option("--description <text>", "REPLACE the freetext description (destructive — the filed report is overwritten; use --append-description to add to it)")
    .option("--body <text>", "Alias for --description (free text, not JSON); if both are given, they must match")
    .option("--append-description <text>", "Append to the CURRENT description (read-merge-write, separated by a blank line) — keeps the original report intact")
    .option(
      "--from-json <file>",
      "Read the payload from a JSON object file (or - for stdin); explicit flags override. Keys: scope, kind, severity, complexity, description (or body), appendDescription. Shell-safe: the only way to pass prose containing quotes on Windows PowerShell."
    )
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
          appendDescription?: string;
          fromJson?: string;
          dryRun?: boolean;
          full?: boolean;
        },
        cmd: Command
      ) => {
        const id = parseRefId(idStr, "feedback", "update");
        // Shared merge: only EXPLICITLY-typed flags outrank the JSON object
        // (feedback #332); unknown or wrong-typed JSON keys exit 4 (fb#298).
        applyFromJson(cmd, opts as Record<string, unknown>, UPDATE_FROM_JSON);
        // --body (argv or JSON) is an alias for --description (feedback #278);
        // fold AFTER the merge so both sources are agreement-checked, mirroring
        // `changelog update` — differing values exit 4 instead of one silently
        // winning.
        const desc = foldAliases(
          [opts.description, opts.body],
          "Provide the description via --description or --body, not both with different values"
        );
        if (desc !== undefined) opts.description = desc;
        const client = await getClient();
        writeJson(
          await runWithSiblingHint(client, id, "changelog", () =>
            runFeedbackUpdate(client, id, {
              scope: opts.scope,
              kind: opts.kind,
              severity: opts.severity,
              complexity: opts.complexity,
              description: opts.description,
              appendDescription: opts.appendDescription,
              dryRun: opts.dryRun,
              full: opts.full,
            })
          )
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
