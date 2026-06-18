import { Command } from "commander";
import { CliError } from "./api/errors.js";

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
  /**
   * Per-invocation company context (`--company <id>`). When set, the command
   * runs as if the active company were this `asiakasId` — `cliContext` performs
   * an EPHEMERAL switch (mints a JWT bound to it, uses it for this one command,
   * and never persists it). `null` = use the credentials' active company.
   * Access is enforced by the switch endpoint; no access → exit 3.
   *
   * Named `--company` on the wire, NOT `--asiakas`: Commander root options are
   * recognized anywhere in argv, so a root `--asiakas` SHADOWS every
   * subcommand's local `--asiakas <id>` flag (14 commands, e.g. `person role
   * grant`, `customer person add`) — their required flag became unsatisfiable.
   */
  asiakas: number | null;
  /**
   * Per-invocation timing. When set, the client measures each request's
   * round-trip and emits one stderr stats line at the end of the command
   * (API time always; SQL time when the backend sends a Server-Timing header).
   * Never touches stdout. Set via `--stats`.
   */
  stats: boolean;
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
    )
    .option(
      "--company <id>",
      "Run this one command in another company's context (ephemeral switch, not persisted)"
    )
    .option("--stats", "Print API (and SQL, when available) timing for this command to stderr");
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
    company?: string;
    stats?: boolean;
  }>();
  const envReadOnly = READ_ONLY_ENV_TRUE.has(
    (process.env.IB_READ_ONLY ?? "").trim().toLowerCase()
  );
  // --company must be a positive integer; fail fast (exit 4 = validation) with
  // a clear message rather than sending NaN→null to the backend and surfacing a
  // cryptic "newAsiakasId is required" HTTP 400. Throws (not process.exit —
  // Windows-unsafe post-fetch); the action catch or the bin catch emits the
  // envelope with exit 4. (No json.js import here: it would be a cycle.)
  let asiakas: number | null = null;
  if (o.company !== undefined) {
    const n = Number(o.company);
    if (!Number.isInteger(n) || n < 1) {
      throw new CliError(
        `--company must be a positive integer (got '${o.company}').`,
        0,
        null,
        4
      );
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
    stats: !!o.stats,
  };
}

export function resolveEndpoint(
  g: GlobalOptions,
  profileEndpoint: string | null
): string {
  return g.endpoint || profileEndpoint || "https://api.ibetoni.fi";
}
