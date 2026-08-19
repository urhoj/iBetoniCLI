// task specs — split from the monolithic specs.ts (fb#782). The barrel
// (src/reference/specs.ts) spreads every segment in a fixed sequence; order
// within this file is load-bearing (catalogue order drives sibling-suggestion
// ranking and the parse-guard-hint snapshots).
import type { CommandSpec } from "../../output/help.js";
import { EXECUTORS as TASK_EXECUTORS, AGENTS as TASK_AGENTS } from "../../commands/task/index.js";
import { clearNote, apiErr, limitErr } from "./shared.js";

export const TASK_SPECS: CommandSpec[] = [
  // ─── task (6) ────────────────────────────────────────────────────────────
  // Recurring operator tasks (weekly/monthly, human or AI executor) over
  // /api/tasks. Hybrid due-since + done-log: DUE when nextDueAt <= now;
  // complete (done/skipped) advances nextDueAt by the cadence; failed only
  // logs so the task stays due. ALL developer-gated server-side this phase.
  {
    command: "ib task list",
    description:
      "List recurring operator tasks, most-overdue first (nextDueAt ASC). Developer-only. Default scope: active tasks; --due narrows to tasks due NOW (nextDueAt <= now); --inactive includes deactivated ones. The daily AI runner sweeps `ib task list --due --executor ai --agent claude`.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    flags: [
      { name: "due", type: "boolean", description: "Only tasks due now (nextDueAt <= now)" },
      { name: "executor", type: "string", description: "human | ai", allowed: [...TASK_EXECUTORS] },
      { name: "agent", type: "string", description: "claude | hermes — recommendedAgent filter (AI tasks)", allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "Only tasks assigned to this personId" },
      { name: "asiakas", type: "number", description: "Only tasks scoped to this company (asiakasId); internal/global tasks have asiakasId NULL" },
      { name: "inactive", type: "boolean", description: "Include deactivated tasks (default: active only)" },
      { name: "limit", type: "number", default: "50", description: "Max rows (cap 200)" },
      { name: "offset", type: "number", default: "0", description: "Pagination offset" },
    ],
    outputShape:
      "{ items: TaskRow[], nextCursor: null, count, truncated? } — TaskRow = { taskId, title, instructions, skillRef, executor, recommendedAgent, assigneePersonId, asiakasId, cadenceUnit, cadenceCount, nextDueAt, lastDoneAt, active, feedbackId, ... }",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--executor must be human|ai; --agent must be claude|hermes; --assignee/--asiakas/--limit/--offset must be integers" },
      apiErr(403, "Permission denied", "requires a developer token (isSystemAdmin/isDeveloper)"),
      apiErr(401, "Token expired", "ib auth refresh"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      "ib task list --due",
      "ib task list --due --executor ai --agent claude",
      "ib task list --executor human --assignee 10",
      "ib task list --asiakas 8 --inactive",
    ],
  },
  {
    command: "ib task get",
    description: "Fetch one recurring task by id (developer-only).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [],
    outputShape:
      "The full task row { taskId, title, instructions, skillRef, executor, recommendedAgent, assigneePersonId, asiakasId, cadenceUnit, cadenceCount, nextDueAt, lastDoneAt, active, feedbackId, createdAt, updatedAt, ... }",
    errors: [
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib task list", "ib task log"],
    examples: ["ib task get 7"],
  },
  {
    command: "ib task add",
    description:
      "Create a recurring task (developer-only; a write). executor=human tasks surface in the morning report for a person to complete; executor=ai tasks are picked up by the daily runner when --skill names a workspace skill (--agent claude) — skill-less or hermes tasks wait and surface in the morning report. Default first due = immediately; the first completion sets the rhythm (nextDueAt = completion time + cadence, rolling, not day-anchored).",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    flags: [
      { name: "title", type: "string", description: "Task title, max 200 chars (required)" },
      { name: "executor", type: "string", description: "human | ai (required)", allowed: [...TASK_EXECUTORS] },
      { name: "cadence", type: "string", description: "<count>/<unit>, unit day|week|month, count 1-120, e.g. 1/month or 2/week. Required unless --once." },
      { name: "once", type: "boolean", description: "SINGLE-SHOT task: completing it (done/skipped) retires the task (active=0) instead of rolling nextDueAt, so it is done forever. Mutually exclusive with --cadence. Pair with --first-due for a 'chase this in N months' reminder. A `failed` completion still leaves it due — a failed attempt has not done the thing." },
      { name: "instructions", type: "string", description: "Freetext checklist for humans / prompt context for the AI runner" },
      { name: "skill", type: "string", description: "Workspace skill the AI runner invokes (e.g. cleanup-docs); omit for human tasks" },
      { name: "agent", type: "string", description: "claude | hermes — recommended AI executor tier (claude = code/advanced, hermes = light local-LLM work)", allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "Human assignee personId" },
      { name: "asiakas", type: "number", description: "Company (asiakasId) the task is scoped to; omit = internal/global" },
      { name: "first-due", type: "string", description: "First due date (YYYY-MM-DD or today/tomorrow); default: due immediately" },
      { name: "feedback", type: "number", description: "cliFeedback id this task graduated from (provenance link)" },
      { name: "from-json", type: "string", description: "Read the whole payload from a JSON object file (or - for stdin); explicit flags override. Keys: title, executor, instructions, skill, agent, assignee, asiakas, cadence, first-due, feedback. An unknown or wrong-typed key exits 4 (never silently dropped). Shell-safe: the way to pass --instructions prose containing quotes on Windows PowerShell." },
    ],
    outputShape: "{ taskId } on success (HTTP 201). With --dry-run: { dryRun:true, wouldWrite:{...} } (server-side preview).",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--title, --executor (human|ai) and one of --cadence (<count>/<unit>) or --once are required (from flags or --from-json); --agent must be claude|hermes; unit must be day|week|month, count 1-120; --assignee/--asiakas/--feedback must be integers" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    notes: [
      "DEPLOY-GATED (fb#534): --once needs a later puminet5api version. Against an older backend it is rejected with `cadenceUnit must be one of: day, week, month` — a clean 400, not a silent recurring task.",
      "--once is NOT a --from-json key. It takes no value, so `\"once\": true` would exit 4 and `\"once\": \"true\"` would be silently dropped, creating a recurring task you believe is one-off (the fb#541 class). Pass --once on argv alongside --from-json.",
    ],
    examples: [
      'ib task add --title "Open purchase invoices review" --executor human --assignee 10 --cadence 1/month --reason "monthly finance check"',
      'ib task add --title "Docs prune sweep" --executor ai --agent claude --skill cleanup-docs --cadence 1/month --reason "ops hygiene"',
      'ib task add --title "KU-oy invoice chase" --executor human --asiakas 8 --cadence 2/week --first-due tomorrow --reason "per-company cadence"',
      'ib task add --title "Activate Hyvinkaan Betoni (non-compete lapses)" --executor human --once --first-due 2026-11-02 --reason "one-time activation"',
    ],
  },
  {
    command: "ib task complete",
    description:
      "Complete a task: append a done-log row and advance nextDueAt = now + cadence (rolling). --skipped also advances; --failed only logs — the task STAYS due (the runner's failure path). AI completions pass --agent so the log distinguishes human vs AI. Developer-only; a write.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [
      { name: "notes", type: "string", description: "Result summary stored on the log row" },
      { name: "skipped", type: "boolean", description: "Log outcome=skipped (advances nextDueAt); mutually exclusive with --failed" },
      { name: "failed", type: "boolean", description: "Log outcome=failed — nextDueAt untouched, task stays due" },
      { name: "agent", type: "string", description: "claude | hermes — set when an AI completes the task", allowed: [...TASK_AGENTS] },
    ],
    outputShape:
      "{ logId, task } (task = the updated row; nextDueAt advanced unless --failed). With --dry-run: { dryRun:true, wouldComplete:{ taskId, outcome, advancesNextDue } }.",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "--skipped and --failed are mutually exclusive; --agent must be claude|hermes" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib task list`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      'ib task complete 7 --notes "reviewed 12 invoices, 2 chased" --reason "monthly run"',
      'ib task complete 7 --agent claude --notes "cleanup-docs pruned 9 files" --reason "recurring-task runner"',
      'ib task complete 7 --failed --agent claude --notes "skill errored: …"',
    ],
  },
  {
    command: "ib task set",
    description:
      'Partial update of a recurring task (developer-only; a write). Omit a flag to KEEP the current value; pass "" to CLEAR a text field (--instructions/--skill/--agent). ' + clearNote("--instructions") + ' --deactivate soft-retires the task (history kept); --activate restores it. --next-due overrides the due date without logging a completion.',
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    writeFlags: true,
    dryRunKind: "server",
    mutates: true,
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [
      { name: "title", type: "string", description: "New title" },
      { name: "instructions", type: "string", description: 'New instructions ("" clears)' },
      { name: "skill", type: "string", description: 'New skillRef ("" clears)' },
      { name: "executor", type: "string", description: "human | ai", allowed: [...TASK_EXECUTORS] },
      { name: "agent", type: "string", description: 'claude | hermes ("" clears)', allowed: [...TASK_AGENTS] },
      { name: "assignee", type: "number", description: "New assignee personId" },
      { name: "asiakas", type: "number", description: "New company scope (asiakasId)" },
      { name: "cadence", type: "string", description: "<count>/<unit>, unit day|week|month, count 1-120. Mutually exclusive with --once." },
      { name: "once", type: "boolean", description: "Convert to a SINGLE-SHOT task (cadenceUnit=once): completion retires it instead of rolling nextDueAt. This is the conversion path for a task already faking 'once' as --cadence 120/month. cadenceCount is left untouched — it is meaningless for a one-off." },
      { name: "next-due", type: "string", description: "Override nextDueAt (YYYY-MM-DD or today/tomorrow)" },
      { name: "activate", type: "boolean", description: "Reactivate; mutually exclusive with --deactivate" },
      { name: "deactivate", type: "boolean", description: "Soft-retire the task (active=0)" },
    ],
    outputShape: "The full updated task row. With --dry-run: { dryRun:true, wouldWrite:{...} } (server-side preview).",
    errors: [
      { origin: "client", exit: 4, meaning: "Validation", remedy: "provide at least one field; --activate/--deactivate and enum values as documented; --assignee/--asiakas must be integers" },
      apiErr(403, "Permission denied", "requires a developer token; also refused under --read-only"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    examples: [
      'ib task set 7 --cadence 2/month --reason "cadence tuning"',
      'ib task set 7 --deactivate --reason "task retired"',
      'ib task set 7 --skill "" --reason "no automation yet — back to morning-report surfacing"',
    ],
  },
  {
    command: "ib task log",
    description: "Completion history for one task, newest first (developer-only). agent non-null = AI completion; outcome failed rows explain why a task is still due.",
    permissions: ["isSystemAdmin or isDeveloper"],
    tier: "developer",
    args: [{ name: "id", type: "number", description: "taskId" }],
    flags: [{ name: "limit", type: "number", default: "50", description: "Max rows (cap 200)" }],
    outputShape:
      "{ items: LogRow[], nextCursor: null, count, truncated? } — LogRow = { logId, taskId, doneAt, donePersonId, agent, outcome, notes }",
    errors: [
      limitErr("pass a positive integer; this command caps at 200, so narrow by task rather than raising the cap"),
      apiErr(403, "Permission denied", "requires a developer token"),
      apiErr(404, "Not found", "check the id via `ib task list --inactive`"),
      apiErr(500, "Backend error", "retry with --verbose"),
    ],
    seeAlso: ["ib task complete", "ib task get"],
    examples: ["ib task log 7", "ib task log 7 --limit 10"],
  },
];
