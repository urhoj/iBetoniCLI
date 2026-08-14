import { CliError, errorMessage, exitCodeForError, hintForError, } from "../api/errors.js";
import { isListEnvelope } from "../api/envelopes.js";
import { renderError, renderList, renderRecord } from "./pretty.js";
import { buildValidationEnvelope } from "./validationEnvelope.js";
import { getEmbeddedCtx } from "../embedded.js";
import { recordFriction } from "../friction.js";
let outputMode = "json";
/**
 * ERRORS rows of the command currently executing, set by the bin preAction
 * hook from its CommandSpec. Lets `writeError` echo the command's OWN
 * documented remedy into the envelope `hint` (feedback #25) instead of only
 * the generic per-status hint. `null` = no spec context (tests, spec-less
 * commands) → generic hints only.
 */
let activeCommandErrors = null;
/**
 * Columns the running command's list table should show under `--pretty`: the
 * CommandSpec's `prettyColumns` (set by `applySpecErrors`), overridden by the
 * global `--columns`. `null` = let `renderList` pick. Ctx-aware for the same
 * reason as {@link activeCommandErrors} — an embedded run must not leak its
 * selection into a concurrent one.
 */
let listColumns = null;
/**
 * Columns the caller EXPLICITLY requested via the global `--columns` flag — a
 * real client-side output projection applied by {@link writeJson} in BOTH JSON
 * and `--pretty` modes (fb#451: the flag used to be a pretty-table-only pick,
 * silently a no-op in JSON mode — exactly where AI callers live). Kept
 * SEPARATE from {@link listColumns}, which is also seeded from the spec's
 * `prettyColumns` — a presentation DEFAULT that must never narrow the JSON
 * contract. Ctx-aware for the same reason as the rest.
 */
let projectionColumns = null;
function emitStdout(line) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.stdout.push(line);
    else
        process.stdout.write(line);
}
function emitStderr(line) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.stderr.push(line);
    else
        process.stderr.write(line);
}
export function setActiveCommandErrors(rows) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.activeCommandErrors = rows;
    else
        activeCommandErrors = rows;
}
export function setListColumns(cols) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.listColumns = cols;
    else
        listColumns = cols;
}
export function setProjectionColumns(cols) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.projectionColumns = cols;
    else
        projectionColumns = cols;
}
const isRow = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * A single record's real payload usually lives in a NESTED list — `ib dev schema
 * table X` returns `{name, columns[], indexes[], triggers[], …}` — which a
 * TOP-LEVEL projection drops in silence. `--columns name` there READS as "the
 * columns' name" but matches the record's own `name` (the TABLE name), so the
 * caller gets `{name:"X"}` while 27 column rows go unmentioned — and the
 * no-match exit-4 guard below is unreachable precisely BECAUSE a column matched
 * (fb#596). Silence is the bug: `{name:"sijainti"}` reads as a successful answer,
 * so a caller can conclude "this table has no columns" rather than "wrong flag".
 *
 * Warn rather than descend into the list: in that same output `name` exists at
 * BOTH levels and there are SEVEN array fields, so picking one would be a guess
 * — and returning its rows would change a record command's output SHAPE from
 * object to array, breaking any caller that parses a record.
 *
 * Array-of-objects only, so scalar arrays (`synonyms`, `tags`) stay quiet; and
 * record-only, because for a list the ROW is the payload and firing per item
 * would be noise.
 */
function warnDroppedNestedLists(record, projected) {
    const dropped = Object.entries(record)
        .filter(([k, v]) => !(k in projected) && Array.isArray(v) && v.length > 0 && isRow(v[0]))
        .map(([k, v]) => {
        const n = v.length;
        return `${k} (${n} ${n === 1 ? "row" : "rows"})`;
    });
    if (dropped.length === 0)
        return;
    warnNote(`[ib] --columns projects TOP-LEVEL fields only — dropped nested list(s): ${dropped.join(", ")}. Re-run without --columns to get them.`);
}
/**
 * Apply the global `--columns` projection to a command's success output
 * (fb#451). A `ListEnvelope` / raw array projects each object row (envelope
 * metadata — `nextCursor`/`count`/`truncated`/`hint` — is kept); a single
 * record projects its top-level keys. LOUD by contract — the old silent no-op
 * was the bug: a requested column matching nothing warns on stderr; when NO
 * requested column matches, or the output is a scalar that cannot be
 * projected at all, the command exits 4 naming what IS available instead of
 * returning the unprojected payload as if the flag had been applied.
 *
 * TOP-LEVEL ONLY — it never reaches into a nested list. A record whose payload
 * lives in one warns instead (fb#596); see {@link warnDroppedNestedLists} for
 * why that case cannot use the exit-4 guard above.
 */
export function applyColumnsProjection(value, cols) {
    let rows;
    if (isListEnvelope(value)) {
        if (value.items.length === 0)
            return value; // empty list: nothing to project
        rows = value.items.filter(isRow);
    }
    else if (Array.isArray(value)) {
        if (value.length === 0)
            return value;
        rows = value.filter(isRow);
    }
    else if (isRow(value)) {
        rows = [value];
    }
    else {
        failUsage(`--columns cannot project this command's output (${value === null ? "null" : typeof value}) — drop --columns here.`);
    }
    if (rows.length === 0) {
        failUsage("--columns cannot project this command's output (its rows are not objects) — drop --columns here.");
    }
    const matched = cols.filter((c) => rows.some((r) => c in r));
    if (matched.length === 0) {
        const available = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        failUsage(`--columns: none of [${cols.join(", ")}] exist in this output. Available: ${available.join(", ")}.`);
    }
    if (matched.length < cols.length) {
        const unknown = cols.filter((c) => !matched.includes(c));
        warnNote(`[ib] --columns: unknown column(s) ignored: ${unknown.join(", ")}`);
    }
    const pick = (r) => {
        const out = {};
        for (const c of cols)
            if (c in r)
                out[c] = r[c];
        return out;
    };
    if (isListEnvelope(value)) {
        return { ...value, items: value.items.map((it) => (isRow(it) ? pick(it) : it)) };
    }
    if (Array.isArray(value))
        return value.map((it) => (isRow(it) ? pick(it) : it));
    const record = value;
    const projected = pick(record);
    warnDroppedNestedLists(record, projected);
    return projected;
}
export function setOutputMode(m) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.outputMode = m;
    else
        outputMode = m;
}
export function writeJson(value) {
    const projection = getEmbeddedCtx()?.projectionColumns ?? projectionColumns;
    if (projection)
        value = applyColumnsProjection(value, projection);
    const mode = getEmbeddedCtx()?.outputMode ?? outputMode;
    if (mode === "pretty") {
        if (isListEnvelope(value)) {
            const cols = getEmbeddedCtx()?.listColumns ?? listColumns;
            emitStdout(renderList(value, cols) + "\n");
            return;
        }
        if (value !== null && typeof value === "object") {
            emitStdout(renderRecord(value) + "\n");
            return;
        }
    }
    emitStdout(JSON.stringify(value) + "\n");
}
/**
 * The single serialization point for error envelopes — the stderr twin of
 * {@link writeJson}, and the only place that decides JSON vs `--pretty` for an
 * error. Every error path (this module's {@link writeError} and the parser's
 * `emitUsageEnvelope`) MUST go through it; writing `JSON.stringify(env)` to
 * stderr directly is what made `--pretty` silently a no-op on every failure.
 * JSON mode is byte-identical to a bare `JSON.stringify` — the machine contract
 * does not move.
 */
export function writeErrorEnvelope(env, exitCode) {
    const mode = getEmbeddedCtx()?.outputMode ?? outputMode;
    emitStderr((mode === "pretty" ? renderError(env, exitCode) : JSON.stringify(env)) + "\n");
}
export function writeError(err) {
    const activeErrors = getEmbeddedCtx()?.activeCommandErrors ?? activeCommandErrors;
    if (err instanceof CliError) {
        const body = err.body && typeof err.body === "object"
            ? err.body
            : {};
        // `hint` points an agent at the next step without it having to have read
        // the command's --help NOTES beforehand (e.g. 404 = deploy-gated endpoint?).
        // Prefers the running command's own spec remedy when one matches.
        const hint = hintForError(err, activeErrors);
        // Local best-effort friction capture (non-embedded only) — the universal
        // error funnel, so every non-zero exit is logged for the feedback groom
        // step. Record the hint alongside the message when one was displayed, so
        // the groomer sees what the caller saw (fb#275 fidelity contract).
        recordFriction(err, undefined, hint ? `${err.message} — ${hint}` : undefined);
        // A prescriptive validation error (thrown via `failValidation`) carries an
        // aggregated `problems` list (+ optional `sample`) in its body — spread them
        // into the envelope so the caller gets every missing/invalid flag, its
        // allowed values, and a copy-paste sample in ONE response (feedback #204).
        const problems = Array.isArray(body.problems) ? body.problems : undefined;
        const sample = typeof body.sample === "string" ? body.sample : undefined;
        writeErrorEnvelope({
            success: false,
            error: err.message,
            code: body.code ?? null,
            statusCode: err.statusCode,
            ...(problems ? { problems } : {}),
            ...(sample ? { sample } : {}),
            ...(hint ? { hint } : {}),
        }, exitCodeForError(err));
        return;
    }
    recordFriction(err);
    writeErrorEnvelope({
        success: false,
        error: errorMessage(err),
        code: null,
        statusCode: 0,
    }, exitCodeForError(err));
}
/**
 * Terminal error handler for command actions: emit the backend-shape error to
 * stderr, then arrange exit with the contract-mapped code (a {@link CliError}
 * carries `2` auth / `3` permission / `4` validation / `5` not-found /
 * `6` server / `7` network; anything else is `1`). Replaces the previous
 * per-command `writeError(e); process.exit(1)` pairs that flattened every API
 * failure to exit `1`, breaking the documented exit-code contract.
 *
 * Sets `process.exitCode` and RETURNS instead of calling `process.exit()`:
 * on Windows, `process.exit()` after a completed `fetch` aborts Node with a
 * libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, win/async.c) and
 * exit 127/0xC0000409 — clobbering the mapped code. The event loop drains
 * immediately (undici sockets are unref'd), so returning is just as prompt.
 * Callers MUST use this in tail position (nothing may run after it).
 */
export function exitWithError(err) {
    writeError(err);
    const code = exitCodeForError(err);
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.exitCode = code;
    else
        process.exitCode = code;
}
/** Set the process/embedded exit code (ctx-aware). Use instead of a bare
 * `process.exitCode = N` so commands report their exit code in in-process mode. */
export function setExitCode(code) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.exitCode = code;
    else
        process.exitCode = code;
}
/**
 * One-line stderr diagnostic — the "[ib] …" notes, warnings, and retry/
 * acting-as lines. Ctx-aware via {@link emitStderr}: in embedded
 * (`/api/cli/exec` in-process) mode the note reaches the CALLER's stderr
 * instead of the host server's, where a bare `console.error` /
 * `process.stderr.write` is invisible to exactly the callers the notes
 * exist for. Never stdout — the JSON data contract is untouched.
 */
export function warnNote(message) {
    emitStderr(message + "\n");
}
export { emitStdout, emitStderr };
/** Re-export: `errorMessage` now lives in `api/errors.ts` (usable below the
 * output layer); command modules keep importing it from here. */
export { errorMessage };
/**
 * Terminate a command from a validation/guard check WITHOUT `process.exit()`
 * (which aborts Node on Windows when called after a completed fetch — libuv
 * UV_HANDLE_CLOSING assert, exit 127). Throws a {@link CliError} carrying the
 * exit code: inside an action try-block the tail `exitWithError` catch turns
 * it into the stderr envelope + mapped exitCode; thrown outside any try it
 * propagates through Commander's parseAsync to the CliError-aware bin catch —
 * same envelope, same code, either way. Replaces every
 * `writeError(...); process.exit(N)` guard pair.
 */
export function failWith(message, exitCode, hint) {
    throw new CliError(message, 0, null, exitCode, hint);
}
/**
 * `failWith` for a validation/USAGE error whose MESSAGE already states the full
 * remedy. Suppresses the command's generic exit-4 spec hint (which would
 * mislead — e.g. `ib legal save`'s "pass --file OR --content" appearing on an
 * unrelated edit-mode error), or sets a positive `hint` to add guidance. Always
 * exit 4 (validation). See {@link CliError.hint} / `hintForError`.
 */
export function failUsage(message, hint = "") {
    return failWith(message, 4, hint);
}
/**
 * Terminate a command with an AGGREGATED, prescriptive validation error
 * (feedback #204). Builds the standard validation envelope for `commandPath`
 * from the supplied flag `problems` — enriching each with its allowed values /
 * synonyms and a copy-paste `sample` from the injected `spec` — then throws a
 * {@link CliError} (exit 4) carrying `{ code, problems, sample }` in its body.
 * {@link writeError} spreads those into the stderr envelope, so the caller sees
 * every problem, its allowed values, and a runnable sample in ONE response
 * instead of fixing one flag, re-running, and hitting the next.
 *
 * Unlike `failWith` (single free-text message), use this whenever ≥1 enum/required
 * flag is wrong so the fixes come back together.
 */
export function failValidation(commandPath, problems, opts = {}) {
    const env = buildValidationEnvelope(commandPath, problems, opts);
    throw new CliError(env.error, 0, { code: env.code, problems: env.problems, ...(env.sample ? { sample: env.sample } : {}) }, 4, env.hint);
}
//# sourceMappingURL=json.js.map