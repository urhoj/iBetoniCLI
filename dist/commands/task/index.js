import { listEnvelope } from "../../api/envelopes.js";
import { failWith } from "../../output/json.js";
import { assertEnum, assertPositiveInt, intFlag } from "../../targets.js";
import { addWriteFlagsToCommand, writeFlagsToHeaders, } from "../../api/writeFlags.js";
import { resolveDate } from "../../dates.js";
import { jsonAction } from "../_shared/action.js";
import { applyFromJson } from "../_shared/fromJson.js";
import { qs } from "../../api/query.js";
// EXECUTORS/AGENTS exported for specs.ts `allowed:` sets (validation envelopes).
export const EXECUTORS = ["human", "ai"];
export const AGENTS = ["claude", "hermes"];
const SERVER_LIST_CAP = 200;
// Uncapped cadenceCount only fails at COMPLETE time (SQL DATEADD overflow 517,
// far from the bad input) — cap it where it is typed. 120 months = 10 years.
const CADENCE_COUNT_MAX = 120;
/**
 * cadenceUnit for a task that runs ONCE and is then retired (active=0) rather
 * than rolling nextDueAt forward (fb#534).
 *
 * Before `--once`, --cadence was REQUIRED, so a genuine single-shot reminder
 * ("activate Hyvinkään Betoni when the non-compete lapses in Nov 2026") had to
 * be dressed up as `--cadence 120/month` — the documented maximum, ~10 years —
 * so completing it rolled nextDueAt to 2036 instead of nagging monthly. It
 * worked, but read as a mistake to the next person and left a magic number with
 * no explanation at the call site.
 */
const ONE_OFF_UNIT = "once";
/** Parse "<count>/<unit>" (e.g. 1/month, 2/week) → cadence fields; exit 4 otherwise. */
export function parseCadence(value) {
    const m = /^(\d+)\/(day|week|month)$/.exec((value ?? "").trim());
    const count = m ? Number(m[1]) : 0;
    if (!m || count < 1 || count > CADENCE_COUNT_MAX) {
        failWith(`--cadence must be <count>/<unit> with unit day|week|month and count 1-${CADENCE_COUNT_MAX} (e.g. 1/month, 2/week)`, 4);
    }
    return { cadenceCount: count, cadenceUnit: m[2] };
}
// intFlag was born here (fb#249) and moved to targets.ts once other domains
// needed it; re-exported so existing importers/tests keep working.
export { intFlag };
/**
 * Envelope from a probe-limit fetch: the request asked for one row PAST
 * `requested` (server cap permitting), so more rows than requested proves
 * truncation exactly; a full page at the server cap stays a heuristic.
 */
function probedEnvelope(rows, requested) {
    const all = Array.isArray(rows) ? rows : [];
    const items = all.slice(0, requested);
    const env = listEnvelope(items);
    if (all.length > requested || all.length >= SERVER_LIST_CAP)
        env.truncated = true;
    return env;
}
function parseTaskId(v, cmd) {
    const n = Number(v);
    assertPositiveInt(n, `task ${cmd}: id`);
    return n;
}
/** GET /api/tasks — most-overdue first; active only unless --inactive. */
export async function runTaskList(client, opts) {
    assertEnum(opts.executor, EXECUTORS, "--executor");
    assertEnum(opts.agent, AGENTS, "--agent");
    const requested = Math.min(Math.max(opts.limit ?? 50, 1), SERVER_LIST_CAP);
    // The boolean flags go out as `1`, not the raw boolean — `qs` would
    // serialise `true` as the literal "true" and change the wire.
    const rows = await client.get(`/api/tasks${qs({
        due: opts.due ? 1 : undefined,
        executor: opts.executor || undefined,
        agent: opts.agent || undefined,
        assignee: opts.assignee,
        asiakas: opts.asiakas,
        includeInactive: opts.inactive ? 1 : undefined,
        limit: Math.min(requested + 1, SERVER_LIST_CAP),
        offset: opts.offset,
    })}`);
    return probedEnvelope(rows, requested);
}
/** GET /api/tasks/:id */
export async function runTaskGet(client, id) {
    return client.get(`/api/tasks/${id}`);
}
/** POST /api/tasks — create a recurring task (developer-only server-side). */
export async function runTaskAdd(client, input, flags) {
    if (!input.title?.trim())
        failWith("--title is required", 4);
    if (!input.executor || !EXECUTORS.includes(input.executor)) {
        failWith(`--executor is required and must be one of: ${EXECUTORS.join(", ")}`, 4);
    }
    assertEnum(input.agent, AGENTS, "--agent");
    if (input.once && input.cadence) {
        failWith("--once and --cadence are mutually exclusive — a one-off has no interval", 4);
    }
    if (!input.once && !input.cadence) {
        failWith("--cadence is required (e.g. 1/month), or --once for a single-shot task", 4);
    }
    // A one-off sends no cadenceCount at all: the backend normalizes it (the
    // column is NOT NULL), and inventing a value here would put a meaningless
    // number on the wire — which is exactly the 120/month problem in miniature.
    const cadence = input.once
        ? { cadenceUnit: ONE_OFF_UNIT, cadenceCount: undefined }
        : parseCadence(input.cadence);
    const body = {
        title: input.title.trim(),
        executor: input.executor,
        cadenceUnit: cadence.cadenceUnit,
    };
    if (cadence.cadenceCount !== undefined)
        body.cadenceCount = cadence.cadenceCount;
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
/**
 * `task add --from-json` (fb#450): --instructions is exactly the long,
 * quote-bearing prose field the JSON path exists to protect from argv quoting.
 * Accepted keys derive from the command's own flags; the write-safety trio and
 * the carrier flag itself are non-payload.
 */
const ADD_FROM_JSON = {
    // `once` is excluded for the fb#541 reason: the accepted-key list is derived
    // from the command's flags, so registering a VALUELESS boolean would advertise
    // a JSON key that cannot work — `"once": true` exits 4 ("must be a string")
    // and `"once": "true"` is accepted and SILENTLY DROPPED, creating a recurring
    // task the caller believes is one-off. Advertising it is worse than omitting
    // it: excluded here it is loudly rejected as unknown, and nothing is lost —
    // --once takes no value, so it has no shell-quoting problem and can be passed
    // on argv alongside --from-json.
    nonPayload: new Set(["fromJson", "dryRun", "idempotencyKey", "reason", "help", "once"]),
    numericFields: new Set(["assignee", "asiakas", "feedback"]),
};
/** POST /api/tasks/:id/complete — done (default) / --skipped / --failed. */
export async function runTaskComplete(client, id, input, flags) {
    if (input.skipped && input.failed) {
        failWith("--skipped and --failed are mutually exclusive", 4);
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
        failWith("--activate and --deactivate are mutually exclusive", 4);
    }
    assertEnum(input.executor, EXECUTORS, "--executor");
    if (input.agent !== undefined && input.agent !== "" && !AGENTS.includes(input.agent)) {
        failWith(`--agent must be one of: ${AGENTS.join(", ")} (or "" to clear)`, 4);
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
    if (input.once && input.cadence !== undefined) {
        failWith("--once and --cadence are mutually exclusive — a one-off has no interval", 4);
    }
    // The CONVERSION path for tasks already faking "once" as --cadence 120/month.
    // cadenceCount is left untouched: it is meaningless for a one-off, and
    // rewriting it would be a second write with no effect on behaviour.
    if (input.once)
        body.cadenceUnit = ONE_OFF_UNIT;
    else if (input.cadence !== undefined) {
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
        failWith("Provide at least one field to update", 4);
    }
    return client.put(`/api/tasks/${id}`, body, {
        headers: writeFlagsToHeaders(flags),
    });
}
/** GET /api/tasks/:id/log — completion history, newest first. */
export async function runTaskLog(client, id, opts) {
    const requested = Math.min(Math.max(opts.limit ?? 50, 1), SERVER_LIST_CAP);
    const probe = Math.min(requested + 1, SERVER_LIST_CAP);
    const rows = await client.get(`/api/tasks/${id}/log?limit=${probe}`);
    return probedEnvelope(rows, requested);
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
        .option("--due")
        .option("--executor <executor>")
        .option("--agent <agent>")
        .option("--assignee <personId>", "", intFlag("--assignee"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--inactive")
        .option("--limit <n>", "", intFlag("--limit"))
        .option("--offset <n>", "", intFlag("--offset", 0))
        .action(jsonAction(getClient, (client, opts) => runTaskList(client, opts)));
    t.command("get <id>")
        // `show` — the reflex spelling for read-one-row (fb#836).
        .alias("show")
        .action(jsonAction(getClient, (client, idStr) => runTaskGet(client, parseTaskId(idStr, "get"))));
    // --title enforced in runTaskAdd, NOT via .requiredOption: it may arrive from
    // --from-json, and Commander's missing-mandatory check would also fire BEFORE
    // its unknown-option check, masking a typo'd flag behind "missing --title"
    // (fb#450 — the fb#309 masking class).
    addWriteFlagsToCommand(t.command("add")
        .option("--title <text>")
        .option("--executor <executor>")
        .option("--instructions <text>")
        .option("--skill <ref>")
        .option("--agent <agent>")
        .option("--assignee <personId>", "", intFlag("--assignee"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--cadence <spec>")
        .option("--once")
        .option("--first-due <date>")
        .option("--feedback <id>", "", intFlag("--feedback"))
        .option("--from-json <file>")).action(jsonAction(getClient, (client, opts, cmd) => {
        // Shared merge: explicitly-typed flags outrank the JSON object; unknown
        // or wrong-typed JSON keys exit 4 (same contract as feedback create).
        applyFromJson(cmd, opts, ADD_FROM_JSON);
        return runTaskAdd(client, opts, opts);
    }));
    addWriteFlagsToCommand(t.command("complete <id>")
        .option("--notes <text>")
        .option("--skipped")
        .option("--failed")
        .option("--agent <agent>")).action(jsonAction(getClient, (client, idStr, opts) => runTaskComplete(client, parseTaskId(idStr, "complete"), opts, opts)));
    addWriteFlagsToCommand(t.command("set <id>")
        .option("--title <text>")
        .option("--instructions <text>")
        .option("--skill <ref>")
        .option("--executor <executor>")
        .option("--agent <agent>")
        .option("--assignee <personId>", "", intFlag("--assignee"))
        .option("--asiakas <id>", "", intFlag("--asiakas"))
        .option("--cadence <spec>")
        .option("--once")
        .option("--next-due <date>")
        .option("--activate")
        .option("--deactivate")).action(jsonAction(getClient, (client, idStr, opts) => runTaskSet(client, parseTaskId(idStr, "set"), opts, opts)));
    t.command("log <id>")
        .option("--limit <n>", "", intFlag("--limit"))
        .action(jsonAction(getClient, (client, idStr, opts) => runTaskLog(client, parseTaskId(idStr, "log"), opts)));
}
//# sourceMappingURL=index.js.map