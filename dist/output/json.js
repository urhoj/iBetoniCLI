import { CliError, exitCodeForError, hintForError } from "../api/errors.js";
import { isListEnvelope } from "../api/envelopes.js";
import { renderList, renderRecord } from "./pretty.js";
import { getEmbeddedCtx } from "../embedded.js";
let outputMode = "json";
/**
 * ERRORS rows of the command currently executing, set by the bin preAction
 * hook from its CommandSpec. Lets `writeError` echo the command's OWN
 * documented remedy into the envelope `hint` (feedback #25) instead of only
 * the generic per-status hint. `null` = no spec context (tests, spec-less
 * commands) → generic hints only.
 */
let activeCommandErrors = null;
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
export function setOutputMode(m) {
    const ctx = getEmbeddedCtx();
    if (ctx)
        ctx.outputMode = m;
    else
        outputMode = m;
}
export function writeJson(value) {
    const mode = getEmbeddedCtx()?.outputMode ?? outputMode;
    if (mode === "pretty") {
        if (isListEnvelope(value)) {
            emitStdout(renderList(value) + "\n");
            return;
        }
        if (value !== null && typeof value === "object") {
            emitStdout(renderRecord(value) + "\n");
            return;
        }
    }
    emitStdout(JSON.stringify(value) + "\n");
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
        emitStderr(JSON.stringify({
            success: false,
            error: err.message,
            code: body.code ?? null,
            statusCode: err.statusCode,
            ...(hint ? { hint } : {}),
        }) + "\n");
        return;
    }
    const message = err instanceof Error ? err.message : String(err);
    emitStderr(JSON.stringify({
        success: false,
        error: message,
        code: null,
        statusCode: 0,
    }) + "\n");
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
export { emitStdout, emitStderr };
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
export function failWith(message, exitCode) {
    throw new CliError(message, 0, null, exitCode);
}
/** Message extraction for failWith when re-raising a caught unknown. */
export function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=json.js.map