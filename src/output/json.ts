import { CliError, exitCodeForError, hintForError } from "../api/errors.js";
import { isListEnvelope, type ListEnvelope } from "../api/envelopes.js";
import { renderList, renderRecord } from "./pretty.js";

let outputMode: "json" | "pretty" = "json";

export function setOutputMode(m: "json" | "pretty"): void {
  outputMode = m;
}

export function writeJson(value: unknown): void {
  if (outputMode === "pretty") {
    if (isListEnvelope(value)) {
      process.stdout.write(renderList(value as ListEnvelope<Record<string, unknown>>) + "\n");
      return;
    }
    if (value !== null && typeof value === "object") {
      process.stdout.write(renderRecord(value as Record<string, unknown>) + "\n");
      return;
    }
  }
  process.stdout.write(JSON.stringify(value) + "\n");
}

export function writeError(err: unknown): void {
  if (err instanceof CliError) {
    const body =
      err.body && typeof err.body === "object"
        ? (err.body as Record<string, unknown>)
        : {};
    // `hint` points an agent at the next step without it having to have read
    // the command's --help NOTES beforehand (e.g. 404 = deploy-gated endpoint?).
    const hint = hintForError(err);
    process.stderr.write(
      JSON.stringify({
        success: false,
        error: err.message,
        code: body.code ?? null,
        statusCode: err.statusCode,
        ...(hint ? { hint } : {}),
      }) + "\n"
    );
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      success: false,
      error: message,
      code: null,
      statusCode: 0,
    }) + "\n"
  );
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
export function exitWithError(err: unknown): void {
  writeError(err);
  process.exitCode = exitCodeForError(err);
}

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
export function failWith(message: string, exitCode: number): never {
  throw new CliError(message, 0, null, exitCode);
}

/** Message extraction for failWith when re-raising a caught unknown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
