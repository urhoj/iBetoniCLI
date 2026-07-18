import { CliError } from "../../api/errors.js";
import { writeJson, exitWithError } from "../../output/json.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { resolveDate } from "../../dates.js";
const EXECUTORS = ["human", "ai"];
const AGENTS = ["claude", "hermes"];
/** Parse "<count>/<unit>" (e.g. 1/month, 2/week) → cadence fields; exit 4 otherwise. */
export function parseCadence(value) {
    const m = /^(\d+)\/(day|week|month)$/.exec((value ?? "").trim());
    if (!m || Number(m[1]) < 1) {
        throw new CliError("--cadence must be <count>/<unit> with unit day|week|month (e.g. 1/month, 2/week)", 400, null, 4);
    }
    return { cadenceCount: Number(m[1]), cadenceUnit: m[2] };
}
function parseTaskId(v, cmd) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
        throw new CliError(`task ${cmd}: id must be a positive integer`, 400, null, 4);
    }
    return n;
}
function assertEnum(value, allowed, flag) {
    if (value !== undefined && !allowed.includes(value)) {
        throw new CliError(`${flag} must be one of: ${allowed.join(", ")}`, 400, null, 4);
    }
}
/** GET /api/tasks — most-overdue first; active only unless --inactive. */
export async function runTaskList(client, opts) {
    assertEnum(opts.executor, EXECUTORS, "--executor");
    assertEnum(opts.agent, AGENTS, "--agent");
    const qs = new URLSearchParams();
    if (opts.due)
        qs.set("due", "1");
    if (opts.executor)
        qs.set("executor", opts.executor);
    if (opts.agent)
        qs.set("agent", opts.agent);
    if (opts.assignee !== undefined)
        qs.set("assignee", String(opts.assignee));
    if (opts.asiakas !== undefined)
        qs.set("asiakas", String(opts.asiakas));
    if (opts.inactive)
        qs.set("includeInactive", "1");
    if (opts.limit !== undefined)
        qs.set("limit", String(opts.limit));
    if (opts.offset !== undefined)
        qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const rows = await client.get(`/api/tasks${suffix}`);
    const items = Array.isArray(rows) ? rows : [];
    const env = {
        items,
        nextCursor: null,
        count: items.length,
    };
    if (items.length >= (opts.limit ?? 50))
        env.truncated = true;
    return env;
}
/** GET /api/tasks/:id */
export async function runTaskGet(client, id) {
    return client.get(`/api/tasks/${id}`);
}
/** POST /api/tasks — create a recurring task (developer-only server-side). */
export async function runTaskAdd(client, input, flags) {
    if (!input.title?.trim())
        throw new CliError("--title is required", 400, null, 4);
    if (!input.executor || !EXECUTORS.includes(input.executor)) {
        throw new CliError(`--executor is required and must be one of: ${EXECUTORS.join(", ")}`, 400, null, 4);
    }
    assertEnum(input.agent, AGENTS, "--agent");
    if (!input.cadence)
        throw new CliError("--cadence is required (e.g. 1/month)", 400, null, 4);
    const { cadenceCount, cadenceUnit } = parseCadence(input.cadence);
    const body = {
        title: input.title.trim(),
        executor: input.executor,
        cadenceUnit,
        cadenceCount,
    };
    if (input.instructions)
        body.instructions = input.instructions;
    if (input.skill)
        body.skillRef = input.skill;
    if (input.agent)
        body.recommendedAgent = input.agent;
    if (input.assignee !== undefined)
        body.assigneePersonId = input.assignee;
    if (input.asiakas !== undefined)
        body.asiakasId = input.asiakas;
    if (input.firstDue)
        body.firstDueAt = resolveDate(input.firstDue);
    if (input.feedback !== undefined)
        body.feedbackId = input.feedback;
    return client.post("/api/tasks", body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** POST /api/tasks/:id/complete — done (default) / --skipped / --failed. */
export async function runTaskComplete(client, id, input, flags) {
    if (input.skipped && input.failed) {
        throw new CliError("--skipped and --failed are mutually exclusive", 400, null, 4);
    }
    assertEnum(input.agent, AGENTS, "--agent");
    const outcome = input.failed ? "failed" : input.skipped ? "skipped" : "done";
    const body = { outcome };
    if (input.agent)
        body.agent = input.agent;
    if (input.notes)
        body.notes = input.notes;
    return client.post(`/api/tasks/${id}/complete`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** Empty string → null (clear the column, glossary-style). */
function emptyToNull(v) {
    return v === "" ? null : v;
}
/** PUT /api/tasks/:id — partial update; omitted flags keep current values. */
export async function runTaskSet(client, id, input, flags) {
    if (input.activate && input.deactivate) {
        throw new CliError("--activate and --deactivate are mutually exclusive", 400, null, 4);
    }
    assertEnum(input.executor, EXECUTORS, "--executor");
    if (input.agent !== undefined && input.agent !== "" && !AGENTS.includes(input.agent)) {
        throw new CliError(`--agent must be one of: ${AGENTS.join(", ")} (or "" to clear)`, 400, null, 4);
    }
    const body = {};
    if (input.title !== undefined)
        body.title = input.title;
    if (input.instructions !== undefined)
        body.instructions = emptyToNull(input.instructions);
    if (input.skill !== undefined)
        body.skillRef = emptyToNull(input.skill);
    if (input.executor !== undefined)
        body.executor = input.executor;
    if (input.agent !== undefined)
        body.recommendedAgent = emptyToNull(input.agent);
    if (input.assignee !== undefined)
        body.assigneePersonId = input.assignee;
    if (input.asiakas !== undefined)
        body.asiakasId = input.asiakas;
    if (input.cadence !== undefined) {
        const { cadenceCount, cadenceUnit } = parseCadence(input.cadence);
        body.cadenceUnit = cadenceUnit;
        body.cadenceCount = cadenceCount;
    }
    if (input.nextDue !== undefined)
        body.nextDueAt = resolveDate(input.nextDue);
    if (input.activate)
        body.active = true;
    if (input.deactivate)
        body.active = false;
    if (Object.keys(body).length === 0) {
        throw new CliError("Provide at least one field to update", 400, null, 4);
    }
    return client.put(`/api/tasks/${id}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** GET /api/tasks/:id/log — completion history, newest first. */
export async function runTaskLog(client, id, opts) {
    const suffix = opts.limit !== undefined ? `?limit=${opts.limit}` : "";
    const rows = await client.get(`/api/tasks/${id}/log${suffix}`);
    const items = Array.isArray(rows) ? rows : [];
    return { items, nextCursor: null, count: items.length };
}
/**
 * Register all `ib task` subcommands:
 *   list | get | add | complete | set | log — all developer-gated server-side.
 */
export function registerTaskCommands(parent, getClient, opts = {}) {
    const t = parent
        .command("task", { hidden: !!opts.hidden })
        .description("Recurring operator tasks — weekly/monthly work for humans + AI (due-since + done-log)");
    t.command("list")
        .description("List recurring tasks, most-overdue first (developer-only)")
        .option("--due", "Only tasks due now (nextDueAt <= now)")
        .option("--executor <executor>", "human | ai")
        .option("--agent <agent>", "claude | hermes (recommendedAgent filter)")
        .option("--assignee <personId>", "Only tasks assigned to this person", Number)
        .option("--asiakas <id>", "Only tasks scoped to this company", Number)
        .option("--inactive", "Include deactivated tasks (default: active only)")
        .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
        .option("--offset <n>", "Pagination offset", Number)
        .action(async (opts) => {
        try {
            writeJson(await runTaskList(await getClient(), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    t.command("get <id>")
        .description("Fetch one recurring task by id (developer-only)")
        .action(async (idStr) => {
        try {
            writeJson(await runTaskGet(await getClient(), parseTaskId(idStr, "get")));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(t.command("add")
        .description("Create a recurring task (developer-only; a write)")
        .requiredOption("--title <text>", "Task title (max 200 chars)")
        .option("--executor <executor>", "human | ai (required)")
        .option("--instructions <text>", "Freetext checklist / AI prompt context")
        .option("--skill <ref>", "Skill the AI runner invokes (e.g. cleanup-docs); omit for human tasks")
        .option("--agent <agent>", "claude | hermes — recommended AI executor tier")
        .option("--assignee <personId>", "Human assignee personId", Number)
        .option("--asiakas <id>", "Company (asiakas) the task is scoped to; omit = internal/global", Number)
        .option("--cadence <spec>", "<count>/<unit>, unit day|week|month (e.g. 1/month, 2/week) — required")
        .option("--first-due <date>", "First due date (YYYY-MM-DD or today/tomorrow); default: due immediately")
        .option("--feedback <id>", "cliFeedback id this task graduated from (provenance)", Number)).action(async (opts) => {
        try {
            writeJson(await runTaskAdd(await getClient(), opts, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(t.command("complete <id>")
        .description("Complete a due task: log done (default) / --skipped / --failed; done+skipped advance nextDueAt (developer-only; a write)")
        .option("--notes <text>", "Result summary stored on the log row")
        .option("--skipped", "Log outcome=skipped (advances nextDueAt)")
        .option("--failed", "Log outcome=failed (task STAYS due)")
        .option("--agent <agent>", "claude | hermes — set when an AI completes the task")).action(async (idStr, opts) => {
        try {
            writeJson(await runTaskComplete(await getClient(), parseTaskId(idStr, "complete"), opts, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    addWriteFlagsToCommand(t.command("set <id>")
        .description("Partial update — omit a flag to keep the current value; \"\" clears text fields (developer-only; a write)")
        .option("--title <text>", "New title")
        .option("--instructions <text>", 'New instructions ("" clears)')
        .option("--skill <ref>", 'New skillRef ("" clears)')
        .option("--executor <executor>", "human | ai")
        .option("--agent <agent>", 'claude | hermes ("" clears)')
        .option("--assignee <personId>", "New assignee personId", Number)
        .option("--asiakas <id>", "New company scope", Number)
        .option("--cadence <spec>", "<count>/<unit>, unit day|week|month")
        .option("--next-due <date>", "Override nextDueAt (YYYY-MM-DD or today/tomorrow)")
        .option("--activate", "Reactivate the task")
        .option("--deactivate", "Deactivate (soft-retire) the task")).action(async (idStr, opts) => {
        try {
            writeJson(await runTaskSet(await getClient(), parseTaskId(idStr, "set"), opts, {
                dryRun: opts.dryRun,
                idempotencyKey: opts.idempotencyKey,
                reason: opts.reason,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    t.command("log <id>")
        .description("Completion history for one task, newest first (developer-only)")
        .option("--limit <n>", "Max rows (default 50, cap 200)", Number)
        .action(async (idStr, opts) => {
        try {
            writeJson(await runTaskLog(await getClient(), parseTaskId(idStr, "log"), opts));
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map