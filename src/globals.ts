import { Command } from "commander";

export interface GlobalOptions {
  endpoint: string | null;
  requestId: string | null;
  quiet: boolean;
  verbose: boolean;
  pretty: boolean;
  json: boolean;
  /**
   * Session write-lock. When true, every non-GET request is refused
   * client-side (exit 3) before any fetch — see `src/api/client.ts`. Set via
   * `--read-only` or `IB_READ_ONLY=1`. Intended for AI/CI sessions that must
   * read but never create/update/delete.
   */
  readOnly: boolean;
}

/** Truthy spellings accepted for the IB_READ_ONLY environment variable. */
const READ_ONLY_ENV_TRUE = new Set(["1", "true", "yes", "on"]);

export function addGlobalOptions(cmd: Command): Command {
  return cmd
    .option("--endpoint <url>", "Override the API base URL")
    .option("--request-id <id>", "Client-supplied request correlation ID")
    .option("--quiet", "Suppress non-data output to stderr")
    .option("--verbose", "Print extra diagnostic lines to stderr")
    .option("--pretty", "Human-readable output (default is JSON)")
    .option("--json", "Force JSON output (default)")
    .option(
      "--read-only",
      "Block all writes this session (also via IB_READ_ONLY=1)"
    );
}

export function getGlobalOptions(cmd: Command): GlobalOptions {
  const o = cmd.opts<{
    endpoint?: string;
    requestId?: string;
    quiet?: boolean;
    verbose?: boolean;
    pretty?: boolean;
    json?: boolean;
    readOnly?: boolean;
  }>();
  const envReadOnly = READ_ONLY_ENV_TRUE.has(
    (process.env.IB_READ_ONLY ?? "").trim().toLowerCase()
  );
  return {
    endpoint: o.endpoint ?? null,
    requestId: o.requestId ?? null,
    quiet: !!o.quiet,
    verbose: !!o.verbose,
    pretty: !!o.pretty,
    json: !!o.json,
    readOnly: !!o.readOnly || envReadOnly,
  };
}

export function resolveEndpoint(
  g: GlobalOptions,
  profileEndpoint: string | null
): string {
  return g.endpoint || profileEndpoint || "https://api.ibetoni.fi";
}
