import { readFileSync } from "node:fs";
import { CliError } from "./errors.js";
/** Truncate a raw body so error output stays readable. */
function preview(raw) {
    return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}
/**
 * Remedy hint for a failed `--body` parse. When the value has `{` but no `"`,
 * the double-quotes were almost certainly stripped by the shell (classic
 * Windows PowerShell behaviour, which eats inner `"` before Node sees the arg),
 * so point at the shell-safe escape hatches. Always echoes the raw value so the
 * caller can SEE what actually arrived.
 */
function bodyParseHint(raw) {
    const base = `received: ${preview(raw)}`;
    const looksQuoteStripped = raw.includes("{") && !raw.includes('"');
    if (!looksQuoteStripped)
        return base;
    return (`${base}\nThe double-quotes are missing — a shell (e.g. Windows PowerShell) likely stripped them. ` +
        `Pass the JSON via --from-json <file|-> (a file, or - for stdin), wrap the whole value in single quotes, or run under Git Bash.`);
}
/**
 * Parse a `--body <json>` flag value into a plain object. A malformed body is
 * caller/validation input, so failures surface as a CliError mapped to exit 4
 * (validation) instead of the generic exit 1 a raw SyntaxError would produce.
 * The error carries a hint echoing the raw value and, when it looks
 * shell-mangled, how to pass JSON safely (see {@link bodyParseHint}).
 */
export function parseJsonBodyFlag(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new CliError(`Invalid --body JSON: ${detail}`, 400, null, 4, bodyParseHint(raw));
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new CliError("--body must be a JSON object", 400, null, 4, bodyParseHint(raw));
    }
    return parsed;
}
/**
 * Read a JSON object from a file path, or from stdin when the path is `-`.
 * Strips a leading BOM. This is the shell-safe alternative to inline `--body`
 * (a shell can strip its inner quotes), and mirrors `ib glossary import`'s
 * file/stdin pattern. Read/parse/shape failures all map to exit 4.
 */
export function readJsonObjectInput(pathOrDash) {
    let raw;
    try {
        raw = (pathOrDash === "-" ? readFileSync(0, "utf8") : readFileSync(pathOrDash, "utf8")).replace(/^\uFEFF/, "");
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new CliError(`Could not read --from-json ${pathOrDash}: ${detail}`, 400, null, 4);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new CliError(`--from-json ${pathOrDash} is not valid JSON: ${detail}`, 400, null, 4);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new CliError("--from-json must contain a JSON object", 400, null, 4);
    }
    return parsed;
}
/**
 * Resolve a JSON object body from either `--from-json` (file/stdin, shell-safe)
 * or an inline `--body` value. Exactly one may be supplied; both → exit 4.
 * When neither is set, returns null (the caller decides whether that is an
 * error — e.g. `person update` requires one, `person create` allows none).
 */
export function resolveJsonObjectBody(opts) {
    if (opts.fromJson !== undefined && opts.body !== undefined) {
        throw new CliError("--body and --from-json are mutually exclusive", 400, null, 4);
    }
    if (opts.fromJson !== undefined)
        return readJsonObjectInput(opts.fromJson);
    if (opts.body !== undefined)
        return parseJsonBodyFlag(opts.body);
    return null;
}
//# sourceMappingURL=parseBody.js.map