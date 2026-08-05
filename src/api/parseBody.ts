import { readFileSync } from "node:fs";
import { CliError, errorMessage } from "./errors.js";

/** Truncate a raw body so error output stays readable. */
function preview(raw: string): string {
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/**
 * Remedy hint for a failed `--body` parse. When the value has `{` but no `"`,
 * the double-quotes were almost certainly stripped by the shell (classic
 * Windows PowerShell behaviour, which eats inner `"` before Node sees the arg),
 * so point at the shell-safe escape hatches. Always echoes the raw value so the
 * caller can SEE what actually arrived.
 */
function bodyParseHint(raw: string): string {
  const base = `received: ${preview(raw)}`;
  const looksQuoteStripped = raw.includes("{") && !raw.includes('"');
  if (!looksQuoteStripped) return base;
  return (
    `${base}\nThe double-quotes are missing — a shell (e.g. Windows PowerShell) likely stripped them. ` +
    `Pass the JSON via --from-json <file|-> (a file, or - for stdin), wrap the whole value in single quotes, or run under Git Bash.`
  );
}

/**
 * Parse a `--body <json>` flag value into a plain object. A malformed body is
 * caller/validation input, so failures surface as a CliError mapped to exit 4
 * (validation) instead of the generic exit 1 a raw SyntaxError would produce.
 * The error carries a hint echoing the raw value and, when it looks
 * shell-mangled, how to pass JSON safely (see {@link bodyParseHint}).
 *
 * `statusCode` is **0** (client-origin), never a fabricated 400 — nothing was
 * sent. See {@link readJsonObjectInput} for why that matters (feedback #307).
 *
 * `flag` names the option in both messages, so the same parser serves the
 * `--data <json>` flags (`ib person notify`, `ib notification fcm send`)
 * without telling their caller to fix a `--body` they never passed.
 */
export function parseJsonBodyFlag(
  raw: string,
  flag = "--body"
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = errorMessage(e);
    throw new CliError(`Invalid ${flag} JSON: ${detail}`, 0, null, 4, bodyParseHint(raw));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${flag} must be a JSON object`, 0, null, 4, bodyParseHint(raw));
  }
  return parsed as Record<string, unknown>;
}

/** Read a file (or stdin when the path is `-`) as UTF-8, stripping a leading BOM. */
function readRawInput(pathOrDash: string): string {
  const raw = pathOrDash === "-" ? readFileSync(0, "utf8") : readFileSync(pathOrDash, "utf8");
  return raw.replace(/^\uFEFF/, "");
}

/**
 * Read and JSON-parse a file (or stdin when the path is `-`), returning whatever
 * shape the document holds — object OR array. The raw fs / `SyntaxError` is left
 * to escape: every caller wraps this in its own catch with a command-specific
 * message, so mapping the failure here would flatten those.
 * Use {@link readJsonObjectInput} when the value must be a JSON object.
 */
export function readJsonInput(path: string): unknown {
  return JSON.parse(readRawInput(path));
}

/**
 * Read a JSON object from a file path, or from stdin when the path is `-`.
 * Strips a leading BOM. This is the shell-safe alternative to inline `--body`
 * (a shell can strip its inner quotes), and mirrors `ib glossary import`'s
 * file/stdin pattern. Read/parse/shape failures all map to exit 4.
 *
 * These are LOCAL failures, so they carry `statusCode: 0` — the documented
 * client-origin marker — not a fabricated HTTP status. They used to throw 400,
 * which (a) told the caller the BACKEND rejected a request that was never sent,
 * (b) made `hintForError` skip the client-row matcher and serve an `http: 400`
 * row's remedy instead (a missing FILE answered with "check --type/--area/--date"
 * on `changelog add`), and (c) logged the same lie to the friction store.
 * Feedback #305/#307 — keep these at 0.
 */
export function readJsonObjectInput(pathOrDash: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readRawInput(pathOrDash);
  } catch (e) {
    const detail = errorMessage(e);
    throw new CliError(`Could not read --from-json ${pathOrDash}: ${detail}`, 0, null, 4);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = errorMessage(e);
    throw new CliError(`--from-json ${pathOrDash} is not valid JSON: ${detail}`, 0, null, 4);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("--from-json must contain a JSON object", 0, null, 4);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Resolve a JSON object body from either `--from-json` (file/stdin, shell-safe)
 * or an inline `--body` value. Exactly one may be supplied; both → exit 4.
 * When neither is set, returns null (the caller decides whether that is an
 * error — e.g. `person update` requires one, `person create` allows none).
 */
export function resolveJsonObjectBody(opts: {
  body?: string;
  fromJson?: string;
}): Record<string, unknown> | null {
  if (opts.fromJson !== undefined && opts.body !== undefined) {
    throw new CliError("--body and --from-json are mutually exclusive", 0, null, 4);
  }
  if (opts.fromJson !== undefined) return readJsonObjectInput(opts.fromJson);
  if (opts.body !== undefined) return parseJsonBodyFlag(opts.body);
  return null;
}
