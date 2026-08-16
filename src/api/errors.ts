import type { CommandError } from "../output/help.js";
import { looksLikeHtml } from "./htmlErrorBody.js";

/** The locally-raised half of {@link CommandError}. */
type ClientCommandError = Extract<CommandError, { origin: "client" }>;
/** The API-originated half of {@link CommandError}. */
type HttpCommandError = Extract<CommandError, { http: number }>;

export class CliError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public body: unknown,
    public exitCode: number,
    /**
     * Optional remedy hint carried by the error itself. When set (a string),
     * it OVERRIDES the command's generic spec remedy in {@link hintForError};
     * an empty string SUPPRESSES the spec remedy (the message is already the
     * full remedy). Used by `failUsage` for self-explanatory usage errors.
     */
    public hint?: string
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * Message extraction for a caught `unknown` — an `Error`'s `message`, anything
 * else `String()`-coerced. Lives here (not in `output/json.ts`) so `src/api/`
 * and `src/auth/` can use it without depending on the output layer; `json.ts`
 * re-exports it for the command modules that already import it from there.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function exitCodeFromStatus(status: number): number {
  if (status === 401) return 2;
  if (status === 403) return 3;
  if (status === 404) return 5;
  if (status >= 400 && status < 500) return 4;
  if (status >= 500) return 6;
  return 1;
}

/**
 * Resolve the process exit code for any thrown value, honouring the documented
 * exit-code contract: a {@link CliError} carries the status-mapped code
 * (2 auth · 3 permission · 4 validation · 5 not-found · 6 server · 7 network),
 * everything else falls back to the generic `1`.
 */
export function exitCodeForError(err: unknown): number {
  return err instanceof CliError ? err.exitCode : 1;
}

/** True when an error body carries the backend's unmatched-route marker. */
function isRouteNotFound(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === "ROUTE_NOT_FOUND"
  );
}

/**
 * Pick the client-side ERRORS row documenting THIS error, for a locally-raised
 * failure (`statusCode === 0`).
 *
 * Two-stage, because exit code alone is far too coarse a key — exit 4 covers
 * nearly every local guard, so the old "first row with this exit" rule served
 * an arbitrary remedy on any command with more than one (feedback #305/#306):
 *
 *  1. A row whose `match` (any entry, when an array) is a substring of the
 *     message wins, case-insensitively.
 *  2. Otherwise fall back to exit-only matching ONLY when the command has
 *     exactly one client row at that exit AND that row declares no `match`.
 *     A row that declares `match` never wins by exit alone, and an ambiguous
 *     set yields NO hint — silence beats a confidently wrong remedy.
 */
function matchClientRow(
  err: CliError,
  specErrors?: CommandError[] | null
): ClientCommandError | undefined {
  const rows = (specErrors ?? []).filter(
    (r): r is ClientCommandError =>
      r.origin === "client" && r.exit === err.exitCode
  );
  const message = err.message.toLowerCase();
  const matched = rows.find((r) => rowMatches(r, message));
  if (matched) return matched;
  return rows.length === 1 && rows[0].match === undefined ? rows[0] : undefined;
}

/** True when a row declares a `match` and any of its alternatives is in `lowerMessage`. */
function rowMatches(row: CommandError, lowerMessage: string): boolean {
  const m = row.match;
  if (m === undefined) return false;
  return (Array.isArray(m) ? m : [m]).some((s) => lowerMessage.includes(s.toLowerCase()));
}

/**
 * Pick the ERRORS row documenting THIS server-originated failure.
 *
 * Keyed on HTTP status — NEVER on exit code (that fallback would reach ~84
 * client rows and mis-hint them, feedback #289). Within the status, a row whose
 * `match` substring is in the message wins over the catch-all, so one status
 * with two causes can carry a remedy for each (fb#485). The catch-all is the
 * FIRST row declaring no `match`, which is byte-for-byte the old behaviour for
 * every spec that has not adopted `match`. When every row at the status declares
 * a `match` and none hit, no row is returned and the caller falls through to the
 * generic per-status hint.
 */
function matchHttpRow(
  err: CliError,
  specErrors?: CommandError[] | null
): HttpCommandError | undefined {
  const rows = (specErrors ?? []).filter(
    (r): r is HttpCommandError => r.http !== undefined && r.http === err.statusCode
  );
  const message = err.message.toLowerCase();
  return rows.find((r) => rowMatches(r, message)) ?? rows.find((r) => r.match === undefined);
}

/**
 * Remedy hint for an error, echoed into the stderr error envelope as `hint`.
 *
 * When the running command's spec ERRORS rows are supplied (resolved by the
 * bin preAction hook), the row matching this error wins: the agent gets the
 * command's OWN documented remedy (e.g. "switch to a provider company")
 * instead of a generic one. A server failure goes through {@link matchHttpRow}
 * (status, then a `match` substring to separate two causes behind one status,
 * then the catch-all row); a locally-raised one (statusCode 0) goes through
 * {@link matchClientRow}, which prefers a row's `match` substring and only falls
 * back to exit-code matching when the command has a single unambiguous client
 * row at that exit. Falls back to the per-status generic hint so an
 * agent that hasn't read --help beforehand still gets pointed at the next
 * step (most importantly the 404 deploy-gate ambiguity). `null` = no hint.
 */
export function hintForError(
  err: CliError,
  specErrors?: CommandError[] | null
): string | null {
  return hintDetailForError(err, specErrors).hint;
}

/**
 * Where a hint came from. `spec` (a matching ERRORS row) and `error` (a remedy
 * the throwing code attached via `failUsage`) mean the COMMAND anticipated this
 * failure; `route-not-found` and `generic` are the CLI's own fallbacks and say
 * nothing about whether the command handled the case.
 */
export type HintSource = "route-not-found" | "error" | "spec" | "generic";
export type HintDetail = { hint: string | null; source: HintSource | null };

/**
 * The hint PLUS its provenance — same resolution as {@link hintForError}, one
 * source of truth, so the two can never drift apart.
 *
 * The distinction is what friction capture keys on (fb#579): a 404 the command
 * DOCUMENTED is evidence the command works, so recording it as friction taxes
 * exactly the negative-path verification that should be encouraged. An
 * undeployed-route or unclassified 404 has no such witness and is still logged.
 */
export function hintDetailForError(
  err: CliError,
  specErrors?: CommandError[] | null
): HintDetail {
  // A not-deployed/unknown route is a DIFFERENT failure class than any documented
  // resource-404, so it wins over the command's own 404 remedy. The backend marks
  // an unmatched /api/* route with code "ROUTE_NOT_FOUND" (app.js catch-all); a
  // deployed route's resource-404 (sendNotFound) carries no such code.
  if (err.statusCode === 404 && isRouteNotFound(err.body)) {
    return {
      hint: "route not found — this endpoint is not deployed on this backend (or the path is wrong). Check the deployed build with `ib version`; deploy-gated commands flag this in their --help NOTES.",
      source: "route-not-found",
    };
  }
  // An error may carry its OWN remedy hint (set via `failUsage`). It wins over
  // the command's generic spec remedy — an empty string suppresses the spec
  // remedy entirely (the message is already the full remedy). This stops a
  // self-explanatory client-side usage error (e.g. "--replace text not found")
  // from inheriting the command's unrelated exit-4 remedy (e.g. legal save's
  // "pass --file OR --content").
  if (typeof err.hint === "string") {
    return err.hint.length ? { hint: err.hint, source: "error" } : { hint: null, source: null };
  }
  // Keyed on the row's DECLARED origin (`CommandError` forces every row to state
  // one): an HTTP failure matches by status, a locally-raised one (statusCode 0)
  // by exit code. Never fall back to exit-matching for HTTP errors — see the
  // CommandError doc comment for why that mis-hints ~84 rows (feedback #289).
  const httpRow = matchHttpRow(err, specErrors);
  if (httpRow?.remedy) return { hint: httpRow.remedy, source: "spec" };
  const clientRow = err.statusCode === 0 ? matchClientRow(err, specErrors) : undefined;
  if (clientRow?.remedy) return { hint: clientRow.remedy, source: "spec" };
  const generic = genericHint(err);
  return generic ? { hint: generic, source: "generic" } : { hint: null, source: null };
}

/** The per-status / per-exit fallback remedy — what to say when nothing command-specific matched. */
function genericHint(err: CliError): string | null {
  if (err.exitCode === 7) {
    // Idempotent reads are already retried twice with backoff before this
    // surfaces (feedback #318), so by the time a caller sees exit 7 on a GET
    // the failure has persisted — saying so stops them burning a retry loop of
    // their own. Writes are NOT retried (a lost reply could mean it landed).
    return "network failure (DNS/connection/TLS) — check connectivity and the --endpoint URL. Idempotent reads were already retried automatically; a write is not retried, so re-run it only if you can confirm it did not land (or pass --idempotency-key).";
  }
  switch (err.statusCode) {
    case 401:
      return "token expired or invalid — run `ib auth refresh` (or `ib auth login`); IB_TOKEN sessions do not auto-refresh";
    case 403:
      return "permission denied — check the PERMISSIONS line in the command's --help and the active company via `ib auth whoami`";
    case 404:
      // Reached only when the body is NOT code:ROUTE_NOT_FOUND (handled above): so
      // the route IS deployed on a current backend → resource-not-found. Deliberately
      // does NOT assert tenancy as the likely cause — plenty of 404s are on GLOBAL,
      // non-tenant resources (command catalog, glossary, reference data), where
      // "check the ACTIVE company" is a false lead (feedback #280). The trailing
      // clause keeps the old ambiguity note for OLDER backends that predate the
      // ROUTE_NOT_FOUND catch-all (their unmatched routes still 404 without a code).
      return "not found — no such resource; if it IS tenant-scoped, check the active company with `ib auth whoami`. (On a current backend an undeployed endpoint instead returns code \"ROUTE_NOT_FOUND\"; older backends omit it, so a 404 there can still mean not-deployed — check `ib version`.)";
    default:
      // An HTML body on a 5xx did not come from the API — Cloudflare replaces an
      // origin 5xx with its own page and discards the JSON, and serves the same
      // page when the origin is briefly unreachable (fb#577). So the generic
      // remedy below is actively WRONG here: it sends the caller to --verbose
      // and to file a backend bug, i.e. to debug an application the request
      // most likely never reached. `ib version` would then report the app
      // healthy, which reads as a mystery rather than as the answer.
      if (err.statusCode >= 500 && looksLikeHtml(err.body)) {
        return "this came from the EDGE (a proxy interstitial), not the application — the request most likely never reached the backend. Retry: it is usually transient. Confirm with `ib version` before assuming an app fault, and use --verbose to see the raw page.";
      }
      if (err.statusCode >= 500) return "backend error — retry with --verbose; if it persists, file `ib dev feedback create --kind bug`";
      return null;
  }
}
