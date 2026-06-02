import { CliError, exitCodeForError } from "../api/errors.js";
import { isListEnvelope } from "../api/envelopes.js";
import { renderList, renderRecord } from "./pretty.js";
let outputMode = "json";
export function setOutputMode(m) {
    outputMode = m;
}
export function writeJson(value) {
    if (outputMode === "pretty") {
        if (isListEnvelope(value)) {
            process.stdout.write(renderList(value) + "\n");
            return;
        }
        if (value !== null && typeof value === "object") {
            process.stdout.write(renderRecord(value) + "\n");
            return;
        }
    }
    process.stdout.write(JSON.stringify(value) + "\n");
}
export function writeError(err) {
    if (err instanceof CliError) {
        const body = err.body && typeof err.body === "object"
            ? err.body
            : {};
        process.stderr.write(JSON.stringify({
            success: false,
            error: err.message,
            code: body.code ?? null,
            statusCode: err.statusCode,
        }) + "\n");
        return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({
        success: false,
        error: message,
        code: null,
        statusCode: 0,
    }) + "\n");
}
/**
 * Terminal error handler for command actions: emit the backend-shape error to
 * stderr, then exit with the contract-mapped code (a {@link CliError} carries
 * `2` auth / `3` permission / `4` validation / `5` not-found / `6` server /
 * `7` network; anything else is `1`). Replaces the previous per-command
 * `writeError(e); process.exit(1)` pairs that flattened every API failure to
 * exit `1`, breaking the documented exit-code contract.
 */
export function exitWithError(err) {
    writeError(err);
    process.exit(exitCodeForError(err));
}
//# sourceMappingURL=json.js.map