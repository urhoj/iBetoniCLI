import { CliError } from "./api/errors.js";
/** Truthy spellings accepted for the IB_READ_ONLY environment variable. */
const READ_ONLY_ENV_TRUE = new Set(["1", "true", "yes", "on"]);
/**
 * The root options, as data. A table rather than a fluent chain because the
 * argv pre-scanner in `domains.ts` has to know which globals swallow the NEXT
 * argv token as their value (otherwise `ib --endpoint http://x keikka …` would
 * read the URL as the command). Deriving that set from these same rows means a
 * new value-taking global can never desync the scanner. Order is the order they
 * appear in `ib --help`.
 */
const GLOBAL_OPTIONS = [
    ["--endpoint <url>", "Override the API base URL"],
    ["--request-id <id>", "Client-supplied request correlation ID"],
    ["--quiet", "Suppress non-data output to stderr"],
    ["--verbose", "Print extra diagnostic lines to stderr"],
    ["--pretty", "Human-readable output (default is JSON)"],
    ["--json", "Force JSON output (default)"],
    ["--read-only", "Block all writes this session (also via IB_READ_ONLY=1)"],
    [
        "--company <id>",
        "Run this one command in another company's context (ephemeral switch, not persisted)",
    ],
    ["--stats", "Print API, SQL, and cache hit/miss timing for this command to stderr"],
    ["--columns <csv>", "Only output these fields (projects lists and single records; loud on no match)"],
];
/** The `-x` / `--xxx` tokens in a Commander flags string (`-e, --endpoint <url>`). */
const flagTokens = (flags) => flags.split(/[\s,|]+/).filter((t) => t.startsWith("-"));
/** Globals that take a value, so an argv scanner must skip the token after them. */
export const GLOBAL_VALUE_FLAGS = new Set(GLOBAL_OPTIONS.filter(([flags]) => /[<[]/.test(flags)).flatMap(([flags]) => flagTokens(flags)));
export function addGlobalOptions(cmd) {
    for (const [flags, description] of GLOBAL_OPTIONS)
        cmd.option(flags, description);
    return cmd;
}
export function getGlobalOptions(cmd) {
    const o = cmd.opts();
    const envReadOnly = READ_ONLY_ENV_TRUE.has((process.env.IB_READ_ONLY ?? "").trim().toLowerCase());
    // --company must be a positive integer; fail fast (exit 4 = validation) with
    // a clear message rather than sending NaN→null to the backend and surfacing a
    // cryptic "newAsiakasId is required" HTTP 400. Throws (not process.exit —
    // Windows-unsafe post-fetch); the action catch or the bin catch emits the
    // envelope with exit 4. (No json.js import here: it would be a cycle.)
    let asiakas = null;
    if (o.company !== undefined) {
        const n = Number(o.company);
        if (!Number.isInteger(n) || n < 1) {
            throw new CliError(`--company must be a positive integer (got '${o.company}').`, 0, null, 4);
        }
        asiakas = n;
    }
    const columns = (o.columns ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    return {
        endpoint: o.endpoint ?? null,
        requestId: o.requestId ?? null,
        quiet: !!o.quiet,
        verbose: !!o.verbose,
        pretty: !!o.pretty,
        json: !!o.json,
        readOnly: !!o.readOnly || envReadOnly,
        asiakas,
        stats: !!o.stats,
        columns: columns.length > 0 ? columns : null,
    };
}
/** Fallback API endpoint when neither --endpoint nor the active profile sets one. */
export const DEFAULT_ENDPOINT = "https://api.ibetoni.fi";
//# sourceMappingURL=globals.js.map