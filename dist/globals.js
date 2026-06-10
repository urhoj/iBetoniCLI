/** Truthy spellings accepted for the IB_READ_ONLY environment variable. */
const READ_ONLY_ENV_TRUE = new Set(["1", "true", "yes", "on"]);
export function addGlobalOptions(cmd) {
    return cmd
        .option("--endpoint <url>", "Override the API base URL")
        .option("--request-id <id>", "Client-supplied request correlation ID")
        .option("--quiet", "Suppress non-data output to stderr")
        .option("--verbose", "Print extra diagnostic lines to stderr")
        .option("--pretty", "Human-readable output (default is JSON)")
        .option("--json", "Force JSON output (default)")
        .option("--read-only", "Block all writes this session (also via IB_READ_ONLY=1)")
        .option("--company <id>", "Run this one command in another company's context (ephemeral switch, not persisted)");
}
export function getGlobalOptions(cmd) {
    const o = cmd.opts();
    const envReadOnly = READ_ONLY_ENV_TRUE.has((process.env.IB_READ_ONLY ?? "").trim().toLowerCase());
    // --company must be a positive integer; fail fast (exit 4 = validation) with a
    // clear message rather than sending NaN→null to the backend and surfacing a
    // cryptic "newAsiakasId is required" HTTP 400.
    let asiakas = null;
    if (o.company !== undefined) {
        const n = Number(o.company);
        if (!Number.isInteger(n) || n < 1) {
            process.stderr.write(`Error: --company must be a positive integer (got '${o.company}').\n`);
            process.exit(4);
        }
        asiakas = n;
    }
    return {
        endpoint: o.endpoint ?? null,
        requestId: o.requestId ?? null,
        quiet: !!o.quiet,
        verbose: !!o.verbose,
        pretty: !!o.pretty,
        json: !!o.json,
        readOnly: !!o.readOnly || envReadOnly,
        asiakas,
    };
}
export function resolveEndpoint(g, profileEndpoint) {
    return g.endpoint || profileEndpoint || "https://api.ibetoni.fi";
}
//# sourceMappingURL=globals.js.map