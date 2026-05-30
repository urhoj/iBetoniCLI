export function addGlobalOptions(cmd) {
    return cmd
        .option("--endpoint <url>", "Override the API base URL")
        .option("--request-id <id>", "Client-supplied request correlation ID")
        .option("--quiet", "Suppress non-data output to stderr")
        .option("--verbose", "Print extra diagnostic lines to stderr")
        .option("--pretty", "Human-readable output (default is JSON)")
        .option("--json", "Force JSON output (default)");
}
export function getGlobalOptions(cmd) {
    const o = cmd.opts();
    return {
        endpoint: o.endpoint ?? null,
        requestId: o.requestId ?? null,
        quiet: !!o.quiet,
        verbose: !!o.verbose,
        pretty: !!o.pretty,
        json: !!o.json,
    };
}
export function resolveEndpoint(g, profileEndpoint) {
    return g.endpoint || profileEndpoint || "https://api.ibetoni.fi";
}
//# sourceMappingURL=globals.js.map