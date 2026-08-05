/**
 * `ib task` — recurring operator tasks (weekly/monthly) for humans + AI.
 *
 * Hybrid due-since + done-log over puminet5api /api/tasks: one template row
 * per task, DUE when nextDueAt <= now; `complete` appends a log row and
 * (unless --failed) advances nextDueAt by the cadence. Developer-gated
 * server-side this phase. Writes carry the standard write flags; --dry-run is
 * SERVER-side (X-Dry-Run honoured by the routes).
 */
import type { Command } from "commander";
import type { ApiClient } from "../../api/client.js";
import { listEnvelope, type ListEnvelope } from "../../api/envelopes.js";
import { failWith } from "../../output/json.js";
import { assertEnum, assertPositiveInt } from "../../targets.js";
import {
  addWriteFlagsToCommand,
  writeFlagsToHeaders,
  type WriteFlags,
} from "../../api/writeFlags.js";
import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { qs } from "../../api/query.js";

const EXECUTORS = ["human", "ai"] as const;
type Executor = (typeof EXECUTORS)[number];
const AGENTS = ["claude", "hermes"] as const;
type Agent = (typeof AGENTS)[number];
const SERVER_LIST_CAP = 200;
// Uncapped cadenceCount only fails at COMPLETE time (SQL DATEADD overflow 517,
// far from the bad input) — cap it where it is typed. 120 months = 10 years.
const CADENCE_COUNT_MAX = 120;

/** Parse "<count>/<unit>" (e.g. 1/month, 2/week) → cadence fields; exit 4 otherwise. */
export function parseCadence(value: string): { cadenceCount: number; cadenceUnit: string } {
  const m = /^(\d+)\/(day|week|month)$/.exec((value ?? "").trim());
  const count = m ? Number(m[1]) : 0;
  if (!m || count < 1 || count > CADENCE_COUNT_MAX) {
    failWith(
      `--cadence must be <count>/<unit> with unit day|week|month and count 1-${CADENCE_COUNT_MAX} (e.g. 1/month, 2/week)`,
      4
    );
  }
  return { cadenceCount: count, cadenceUnit: m[2] };
}

/**
 * Commander argParser: strict integer >= min; exit 4 otherwise. Bare `Number`
 * lets NaN through — the backend silently drops a NaN filter and returns ALL
 * rows (fb#249).
 */
export function intFlag(flag: string, min = 1): (value: string) => number {
  return (value: string) => {
    const n = Number((value ?? "").trim());
    if (!Number.isSafeInteger(n) || n < min) {
      failWith(`${flag} must be an integer >= ${min}`, 4);
    }
    return n;
  };
}

/**
 * Envelope from a probe-limit fetch: the request asked for one row PAST
 * `requested` (server cap permitting), so more rows than requested proves
 * truncation exactly; a full page at the server cap stays a heuristic.
 */
function probedEnvelope(
  rows: Record<string, unknown>[],
  requested: number
): ListEnvelope<Record<string, unknown>> {
  const all = Array.isArray(rows) ? rows : [];
  const items = all.slice(0, requested);
  const env = listEnvelope(items);
  if (all.length > requested || all.length >= SERVER_LIST_CAP) env.truncated = true;
  return env;
}

function parseTaskId(v: string, cmd: string): number {
  const n = Number(v);
  assertPositiveInt(n, `task ${cmd}: id`);
  return n;
}

export interface TaskListOptions {
  due?: boolean;
  executor?: string;
  agent?: string;
  assignee?: number;
  asiakas?: number;
  inactive?: boolean;
  limit?: number;
  offset?: number;
}

/** GET /api/tasks — most-overdue first; active only unless --inactive. */
export async function runTaskList(
  client: ApiClient,
  opts: TaskListOptions
): Promise<ListEnvelope<Record<string, unknown>>> {
  assertEnum(opts.executor, EXECUTORS, "--executor");
  assertEnum(opts.agent, AGENTS, "--agent");
  const requested = Math.min(Math.max(opts.limit ?? 50, 1), SERVER_LIST_CAP);
  // The boolean flags go out as `1`, not the raw boolean — `qs` would
  // serialise `true` as the literal "true" and change the wire.
  const rows = await client.get<Record<string, unknown>[]>(
    `/api/tasks${qs({
      due: opts.due ? 1 : undefined,
      executor: opts.executor || undefined,
      agent: opts.agent || undefined,
      assignee: opts.assignee,
      asiakas: opts.asiakas,
      includeInactive: opts.inactive ? 1 : undefined,
      limit: Math.min(requested + 1, SERVER_LIST_CAP),
      offset: opts.offset,
    })}`
  );
  return probedEnvelope(rows, requested);
}

/** GET /api/tasks/:id */
export async function runTaskGet(client: ApiClient, id: number): Promise<Record<string, unknown>> {
  return client.get<Record<string, unknown>>(`/api/tasks/${id}`);
}

export interface TaskAddInput {
  title?: string;
  executor?: string;
  instructions?: string;
  skill?: string;
  agent?: string;
  assignee?: number;
  asiakas?: number;
  cadence?: string;
  firstDue?: string;
  feedback?: number;
}

/** POST /api/tasks — create a recurring task (developer-only server-side). */
export async function runTaskAdd(
  client: ApiClient,
  input: TaskAddInput,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  if (!input.title?.trim()) failWith("--title is required", 4);
  if (!input.executor || !EXECUTORS.includes(input.executor as Executor)) {
    failWith(`--executor is required and must be one of: ${EXECUTORS.join(", ")}`, 4);
  }
  assertEnum(input.agent, AGENTS, "--agent");
  if (!input.cadence) failWith("--cadence is required (e.g. 1/month)", 4);
  const { cadenceCount, cadenceUnit } = parseCadence(input.cadence);

  const body: Record<string, unknown> = {
    title: input.title.trim(),
    executor: input.executor,
    cadenceUnit,
    cadenceCount,
  };
  if (input.instructions) body.instructions = input.instructions;
  if (input.skill) body.skillRef = input.skill;
  if (input.agent) body.recommendedAgent = input.agent;
  if (input.assignee !== undefined) body.assigneePersonId = input.assignee;
  if (input.asiakas !== undefined) body.asiakasId = input.asiakas;
  if (input.firstDue) body.firstDueAt = resolveDate(input.firstDue);
  if (input.feedback !== undefined) body.feedbackId = input.feedback;
  return client.post<Record<string, unknown>>("/api/tasks", body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface TaskCompleteInput {
  skipped?: boolean;
  failed?: boolean;
  agent?: string;
  notes?: string;
}

/** POST /api/tasks/:id/complete — done (default) / --skipped / --failed. */
export async function runTaskComplete(
  client: ApiClient,
  id: number,
  input: TaskCompleteInput,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  if (input.skipped && input.failed) {
    failWith("--skipped and --failed are mutually exclusive", 4);
  }
  assertEnum(input.agent, AGENTS, "--agent");
  const outcome = input.failed ? "failed" : input.skipped ? "skipped" : "done";
  const body: Record<string, unknown> = { outcome };
  if (input.agent) body.agent = input.agent;
  if (input.notes) body.notes = input.notes;
  return client.post<Record<string, unknown>>(`/api/tasks/${id}/complete`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

export interface TaskSetInput {
  title?: string;
  instructions?: string;
  skill?: string;
  executor?: string;
  agent?: string;
  assignee?: number;
  asiakas?: number;
  cadence?: string;
  nextDue?: string;
  activate?: boolean;
  deactivate?: boolean;
}

/** Empty string → null (clear the column, glossary-style). */
function emptyToNull(v: string): string | null {
  return v === "" ? null : v;
}

/** PUT /api/tasks/:id — partial update; omitted flags keep current values. */
export async function runTaskSet(
  client: ApiClient,
  id: number,
  input: TaskSetInput,
  flags: WriteFlags
): Promise<Record<string, unknown>> {
  if (input.activate && input.deactivate) {
    failWith("--activate and --deactivate are mutually exclusive", 4);
  }
  assertEnum(input.executor, EXECUTORS, "--executor");
  if (input.agent !== undefined && input.agent !== "" && !AGENTS.includes(input.agent as Agent)) {
    failWith(`--agent must be one of: ${AGENTS.join(", ")} (or "" to clear)`, 4);
  }
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.title = input.title;
  if (input.instructions !== undefined) body.instructions = emptyToNull(input.instructions);
  if (input.skill !== undefined) body.skillRef = emptyToNull(input.skill);
  if (input.executor !== undefined) body.executor = input.executor;
  if (input.agent !== undefined) body.recommendedAgent = emptyToNull(input.agent);
  if (input.assignee !== undefined) body.assigneePersonId = input.assignee;
  if (input.asiakas !== undefined) body.asiakasId = input.asiakas;
  if (input.cadence !== undefined) {
    const { cadenceCount, cadenceUnit } = parseCadence(input.cadence);
    body.cadenceUnit = cadenceUnit;
    body.cadenceCount = cadenceCount;
  }
  if (input.nextDue !== undefined) body.nextDueAt = resolveDate(input.nextDue);
  if (input.activate) body.active = true;
  if (input.deactivate) body.active = false;
  if (Object.keys(body).length === 0) {
    failWith("Provide at least one field to update", 4);
  }
  return client.put<Record<string, unknown>>(`/api/tasks/${id}`, body, {
    headers: writeFlagsToHeaders(flags),
  });
}

/** GET /api/tasks/:id/log — completion history, newest first. */
export async function runTaskLog(
  client: ApiClient,
  id: number,
  opts: { limit?: number }
): Promise<ListEnvelope<Record<string, unknown>>> {
  const requested = Math.min(Math.max(opts.limit ?? 50, 1), SERVER_LIST_CAP);
  const probe = Math.min(requested + 1, SERVER_LIST_CAP);
  const rows = await client.get<Record<string, unknown>[]>(`/api/tasks/${id}/log?limit=${probe}`);
  return probedEnvelope(rows, requested);
}

/**
 * Register all `ib task` subcommands:
 *   list | get | add | complete | set | log — all developer-gated server-side.
 */
export function registerTaskCommands(
  parent: Command,
  getClient: () => Promise<ApiClient>,
  opts: { hidden?: boolean } = {}
): void {
  const t = parent
    .command("task", { hidden: !!opts.hidden })
    .description("Recurring operator tasks — weekly/monthly work for humans + AI (due-since + done-log)");

  t.command("list")
    .option("--due", "Only tasks due now (nextDueAt <= now)")
    .option("--executor <executor>", "human | ai")
    .option("--agent <agent>", "claude | hermes (recommendedAgent filter)")
    .option("--assignee <personId>", "Only tasks assigned to this person", intFlag("--assignee"))
    .option("--asiakas <id>", "Only tasks scoped to this company", intFlag("--asiakas"))
    .option("--inactive", "Include deactivated tasks (default: active only)")
    .option("--limit <n>", "Max rows (default 50, cap 200)", intFlag("--limit"))
    .option("--offset <n>", "Pagination offset", intFlag("--offset", 0))
    .action(jsonAction(getClient, (client, opts: TaskListOptions) => runTaskList(client, opts)));

  t.command("get <id>")
    .action(
      jsonAction(getClient, (client, idStr: string) =>
        runTaskGet(client, parseTaskId(idStr, "get"))
      )
    );

  addWriteFlagsToCommand(
    t.command("add")
      .requiredOption("--title <text>", "Task title (max 200 chars)")
      .option("--executor <executor>", "human | ai (required)")
      .option("--instructions <text>", "Freetext checklist / AI prompt context")
      .option("--skill <ref>", "Skill the AI runner invokes (e.g. cleanup-docs); omit for human tasks")
      .option("--agent <agent>", "claude | hermes — recommended AI executor tier")
      .option("--assignee <personId>", "Human assignee personId", intFlag("--assignee"))
      .option("--asiakas <id>", "Company (asiakas) the task is scoped to; omit = internal/global", intFlag("--asiakas"))
      .option("--cadence <spec>", "<count>/<unit>, unit day|week|month, count 1-120 (e.g. 1/month, 2/week) — required")
      .option("--first-due <date>", "First due date (YYYY-MM-DD or today/tomorrow); default: due immediately")
      .option("--feedback <id>", "cliFeedback id this task graduated from (provenance)", intFlag("--feedback"))
  ).action(
    jsonAction(getClient, (client, opts: TaskAddInput & WriteFlags) =>
      runTaskAdd(client, opts, opts)
    )
  );

  addWriteFlagsToCommand(
    t.command("complete <id>")
      .option("--notes <text>", "Result summary stored on the log row")
      .option("--skipped", "Log outcome=skipped (advances nextDueAt)")
      .option("--failed", "Log outcome=failed (task STAYS due)")
      .option("--agent <agent>", "claude | hermes — set when an AI completes the task")
  ).action(
    jsonAction(getClient, (client, idStr: string, opts: TaskCompleteInput & WriteFlags) =>
      runTaskComplete(client, parseTaskId(idStr, "complete"), opts, opts)
    )
  );

  addWriteFlagsToCommand(
    t.command("set <id>")
      .option("--title <text>", "New title")
      .option("--instructions <text>", 'New instructions ("" clears)')
      .option("--skill <ref>", 'New skillRef ("" clears)')
      .option("--executor <executor>", "human | ai")
      .option("--agent <agent>", 'claude | hermes ("" clears)')
      .option("--assignee <personId>", "New assignee personId", intFlag("--assignee"))
      .option("--asiakas <id>", "New company scope", intFlag("--asiakas"))
      .option("--cadence <spec>", "<count>/<unit>, unit day|week|month, count 1-120")
      .option("--next-due <date>", "Override nextDueAt (YYYY-MM-DD or today/tomorrow)")
      .option("--activate", "Reactivate the task")
      .option("--deactivate", "Deactivate (soft-retire) the task")
  ).action(
    jsonAction(getClient, (client, idStr: string, opts: TaskSetInput & WriteFlags) =>
      runTaskSet(client, parseTaskId(idStr, "set"), opts, opts)
    )
  );

  t.command("log <id>")
    .option("--limit <n>", "Max rows (default 50, cap 200)", intFlag("--limit"))
    .action(
      jsonAction(getClient, (client, idStr: string, opts: { limit?: number }) =>
        runTaskLog(client, parseTaskId(idStr, "log"), opts)
      )
    );
}
