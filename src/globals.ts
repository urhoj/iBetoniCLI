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
   * (API time always; SQL time and cache hit/miss counts when the backend
   * sends a Server-Timing header). Never touches stdout. Set via `--stats`.
   */
  stats: boolean;
  /**
   * Output projection (`--columns a,b,c`): the success output keeps only the
   * named top-level fields — each row of a list (`ListEnvelope` items / raw
   * arrays, envelope metadata kept) or the single record. Applied at the
   * `writeJson` chokepoint in BOTH JSON and `--pretty` modes; under `--pretty`
   * it also overrides the spec's `prettyColumns` table pick. LOUD by contract
   * (fb#451 — it used to be a pretty-table-only pick, silently a no-op in JSON
   * mode): unknown columns warn on stderr; no matching column, or output that
   * cannot be projected (a scalar), exits 4 naming what IS available.
   * `null` = not set.
   *
   * TOP-LEVEL ONLY — it never reaches into a nested list, and a record whose
   * payload lives in one (`ib dev schema table X` → `columns[]`) warns on stderr
   * rather than failing, because a top-level key DID match and the exit-4 guard
   * is therefore unreachable (fb#596).
   *
   * Named `--columns`, NOT `--fields`: a root option is recognized anywhere in
   * argv and would SHADOW the per-command `--fields <csv>` that
   * `customer list` / `ohje list` already own (the same trap documented on
   * `--company` above) — those two are a SERVER-side projection; this one is
   * client-side over the returned payload, so the two compose (intersection).
   */
  columns: string[] | null;
  /**
   * Request introspection (`--print-payload`): the client emits each RESOLVED
   * request — method, path, headers (Authorization redacted), body — to stderr
   * just before it is sent. Answers "did my flags parse into the body I
   * intended?", which fb#636 could not answer through `ib` at all: server
   * `--dry-run` is deploy-gated and can still persist, and `--read-only` refuses
   * naming only the method and path, discarding the assembled body unseen.
   *
   * Emits and CONTINUES rather than print-and-abort, so no `run*` function ever
   * receives a stub response to project into garbage. Pair with `--read-only`
   * for "show me, send nothing" — the payload prints, then the write-lock
   * refuses. Covers GETs too, so the read half of a read-merge-write is visible;
   * that is precisely where a silently-dropped merge field hides.
   */
  printPayload: boolean;
}

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
const GLOBAL_OPTIONS: ReadonlyArray<readonly [flags: string, description: string]> = [
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
  [
    "--columns <csv>",
    "Only output these TOP-LEVEL fields (projects list rows and single records; never reaches into a nested list; loud on no match)",
  ],
  [
    "--print-payload",
    "Print each resolved request (method, path, headers, body) to stderr before it is sent; combine with --read-only to inspect a write without sending it",
  ],
];

/** The `-x` / `--xxx` tokens in a Commander flags string (`-e, --endpoint <url>`). */
const flagTokens = (flags: string): string[] =>
  flags.split(/[\s,|]+/).filter((t) => t.startsWith("-"));

/** Globals that take a value, so an argv scanner must skip the token after them. */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(
  GLOBAL_OPTIONS.filter(([flags]) => /[<[]/.test(flags)).flatMap(([flags]) => flagTokens(flags))
);

export function addGlobalOptions(cmd: Command): Command {
  for (const [flags, description] of GLOBAL_OPTIONS) cmd.option(flags, description);
  return cmd;
}

/**
 * The one-line GLOBAL FLAGS summary rendered into every command's `--help`,
 * derived from {@link GLOBAL_OPTIONS} rather than restated.
 *
 * It was a hand-maintained string literal in `output/help.ts`, which is a silent
 * drift hazard of exactly the kind this CLI keeps getting bitten by: adding a
 * global wires it up everywhere EXCEPT the help text, so the flag works but is
 * undiscoverable, and nothing fails. `--print-payload` (fb#636) was the first
 * one to notice it.
 *
 * `<url>` renders as `URL` to match the established shape (`--company ID`,
 * `--columns CSV`); valueless flags render as-is.
 */
export function globalFlagsSummary(): string {
  return GLOBAL_OPTIONS.map(([flags]) =>
    flags.replace(/<([^>]+)>/g, (_m, name: string) => name.toUpperCase())
  ).join("  ");
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
    columns?: string;
    printPayload?: boolean;
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
    printPayload: !!o.printPayload,
  };
}

/** Fallback API endpoint when neither --endpoint nor the active profile sets one. */
export const DEFAULT_ENDPOINT = "https://api.ibetoni.fi";
