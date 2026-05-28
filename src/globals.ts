import { Command } from "commander";

export interface GlobalOptions {
  endpoint: string | null;
  requestId: string | null;
  quiet: boolean;
  verbose: boolean;
  pretty: boolean;
  json: boolean;
}

export function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--endpoint <url>", "Override the API base URL")
    .option("--request-id <id>", "Client-supplied request correlation ID")
    .option("--quiet", "Suppress non-data output to stderr")
    .option("--verbose", "Print extra diagnostic lines to stderr")
    .option("--pretty", "Human-readable output (default is JSON)")
    .option("--json", "Force JSON output (default)");
}

export function getGlobalOptions(cmd: Command): GlobalOptions {
  const o = cmd.opts<{
    endpoint?: string;
    requestId?: string;
    quiet?: boolean;
    verbose?: boolean;
    pretty?: boolean;
    json?: boolean;
  }>();
  return {
    endpoint: o.endpoint ?? null,
    requestId: o.requestId ?? null,
    quiet: !!o.quiet,
    verbose: !!o.verbose,
    pretty: !!o.pretty,
    json: !!o.json,
  };
}

export function resolveEndpoint(
  g: GlobalOptions,
  profileEndpoint: string | null
): string {
  return g.endpoint || profileEndpoint || "https://api.ibetoni.fi";
}
