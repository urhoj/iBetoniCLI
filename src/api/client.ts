import { randomUUID } from "node:crypto";
import { CliError, exitCodeFromStatus } from "./errors.js";
import { recordRequest, statsEnabled } from "../stats.js";

/**
 * BetoniJerry umbrella tenant (`@ibetoni/constants` BETONIJERRY.OWNER_ASIAKAS_ID).
 * Writes resolved against it touch the shared umbrella org, so the acting-as
 * diagnostic flags it loudly. Inlined (stable tenant id) to keep the client
 * free of the CJS constants require on its hot path.
 */
const BETONIJERRY_UMBRELLA_ASIAKAS_ID = 1349;

/**
 * Derive a human/agent-readable message from a parsed error body. `sendError`
 * returns `{ error: "<string>" }`, but other layers (rate-limit, oauth) may
 * nest it (`{ error: { message, code } }`) or send `{ message }`. The old
 * `String(parsed.error)` turned a nested object into the literal
 * `"[object Object]"`, defeating the machine-parseable-error contract — so dig
 * out a real string before falling back to `HTTP <status>`.
 */
function errorMessageFromBody(parsed: unknown, status: number): string {
  const fallback = `HTTP ${status}`;
  if (typeof parsed === "string" && parsed) return parsed;
  if (!parsed || typeof parsed !== "object") return fallback;
  const body = parsed as Record<string, unknown>;
  const err = body.error ?? body.message;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const nested =
      (err as Record<string, unknown>).message ??
      (err as Record<string, unknown>).error;
    if (typeof nested === "string" && nested) return nested;
    return JSON.stringify(err);
  }
  return fallback;
}

interface ApiClientOptions {
  endpoint: string;
  token: string;
  version: string;
  requestId?: string;
  /**
   * Optional callback invoked on a 401 to obtain a freshly-issued JWT.
   * If provided, the client retries the request ONCE with the new token.
   * Caller is responsible for persisting the rotated token (read it back via
   * `getCurrentToken()`).
   */
  onRefresh?: (currentJwt: string) => Promise<string>;
  /**
   * Session write-lock (`--read-only` / `IB_READ_ONLY`). When true, any non-GET
   * request is refused before a fetch is issued — the single client-side
   * chokepoint guaranteeing no create/update/delete leaves the process. GETs
   * (including the read half of a read-merge-write) are unaffected.
   */
  readOnly?: boolean;
  /**
   * The company the active JWT acts as. When set, the FIRST write (non-GET) of
   * the process prints a one-line stderr diagnostic naming that company — a
   * guardrail against "wrong company lens" writes after a company switch. This
   * is the token's AUTH/company lens, NOT a per-command cross-tenant `--asiakas`
   * target: a write carrying `--asiakas 1377` is still authorized under this
   * lens but persists against 1377, which this line does not (and cannot, at the
   * HTTP layer) know — hence the "acting as" framing rather than a "→ target"
   * arrow (feedback #118). Decoded from the JWT by the caller (free, no network).
   * Suppressed by `quiet`.
   */
  actingAs?: { ownerAsiakasId: number; ownerAsiakasName?: string };
  /** Suppress non-data stderr diagnostics (the acting-as line). */
  quiet?: boolean;
}

interface FetchOptions {
  headers?: Record<string, string>;
  /**
   * Marks a request as a META call (feedback/diagnostics), not a domain
   * mutation. A meta non-GET is EXEMPT from the read-only write-lock and skips
   * the acting-as write diagnostic — so an agent running `--read-only` can still
   * file `ib feedback`. Use ONLY for endpoints that don't mutate tenant data.
   */
  meta?: boolean;
  /**
   * Marks a tenant-scoped READ that happens to use POST (e.g. /api/person/search,
   * /api/tyomaa/search). Exempt from the read-only write-lock and the acting-as
   * write diagnostic — it does not mutate. Distinct from `meta` (a non-tenant
   * diagnostic). Apply ONLY to genuinely non-mutating endpoints.
   */
  read?: boolean;
}

/**
 * HTTP header values must be a ByteString (Latin-1, code points 0–255). Free-text
 * header values — notably --reason (`X-Action-Reason`) and --idempotency-key — can
 * carry Unicode punctuation (em/en dashes, curly quotes, …, €) that makes the
 * runtime `fetch` throw "Cannot convert argument to a ByteString" BEFORE the
 * request is sent, crashing the whole command client-side. Transliterate the
 * common offenders to ASCII and replace any remaining >255 code point with '?',
 * so a reason with fancy characters degrades gracefully instead of aborting the
 * call. Latin-1 text (incl. Finnish ä/ö/å) passes through unchanged.
 */
export function sanitizeHeaderValue(value: string): string {
  // Fast path: only printable Latin-1 code points (U+0020-U+00FF) present.
  if (!/[^\u0020-\u00ff]/.test(value)) return value;
  return value
    .replace(/[\u2010-\u2015]/g, "-") // hyphens & dashes
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'") // single curly quotes
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"') // double curly quotes
    .replace(/\u2026/g, "...") // ellipsis
    .replace(/\u20ac/g, "EUR") // euro sign
    .replace(/[^\u0020-\u00ff]/g, "?"); // remaining >255 + control chars
}

export function createApiClient({
  endpoint,
  token,
  version,
  requestId,
  onRefresh,
  readOnly = false,
  actingAs,
  quiet = false,
}: ApiClientOptions) {
  const platform = `${process.platform} node-${process.versions.node}`;
  const userAgent = `ib-cli/${version} (${platform})`;
  let currentToken = token;
  let actingAsAnnounced = false;

  /**
   * Print the acting-as company once, before the process's first write. No-op
   * when quiet, when no identity was supplied, or already announced.
   *
   * "acting as", not "→ asiakasId": this names the token's company lens, which
   * for a cross-tenant `--asiakas <id>` write is NOT the row's target (the write
   * lands on `<id>`, not on the lens). The old "write → asiakasId N" arrow read
   * as a destination and masked wrong-target mistakes (feedback #118); the HTTP
   * layer can't see per-command targets, so we frame it as the auth lens.
   */
  function announceActingAs(): void {
    if (quiet || !actingAs || actingAsAnnounced) return;
    actingAsAnnounced = true;
    const name = actingAs.ownerAsiakasName ? ` (${actingAs.ownerAsiakasName})` : "";
    const umbrella =
      actingAs.ownerAsiakasId === BETONIJERRY_UMBRELLA_ASIAKAS_ID
        ? "  ⚠ BetoniJerry umbrella tenant"
        : "";
    process.stderr.write(
      `[ib] write · acting as asiakasId ${actingAs.ownerAsiakasId}${name}${umbrella}\n`
    );
  }

  function buildHeaders(
    extra: Record<string, string> = {},
    withBody = false
  ): Record<string, string> {
    const merged: Record<string, string> = {
      Authorization: `Bearer ${currentToken}`,
      "User-Agent": userAgent,
      "X-Request-ID": requestId || randomUUID(),
      ...(withBody ? { "Content-Type": "application/json" } : {}),
      ...extra,
    };
    // Header values must be a Latin-1 ByteString or `fetch` throws before the
    // request is sent. Sanitize every value (no-op for already-clean ASCII /
    // Latin-1) so a --reason with an em dash, curly quote, € etc. can't crash
    // the command. Central choke point: all requests flow through here.
    for (const key of Object.keys(merged)) {
      merged[key] = sanitizeHeaderValue(merged[key]);
    }
    return merged;
  }

  async function doFetch(
    method: string,
    path: string,
    body: unknown,
    opts: FetchOptions
  ): Promise<Response> {
    const url = `${endpoint}${path}`;
    const withBody = method !== "GET" && body !== undefined;
    return fetch(url, {
      method,
      headers: buildHeaders(opts.headers, withBody),
      body: withBody ? JSON.stringify(body) : undefined,
    });
  }

  // A fetch rejection (DNS failure, connection refused, TLS error, …) is a
  // network problem, not an HTTP status — surface it as a CliError mapped to
  // the documented `7` network exit code instead of letting a raw TypeError
  // escape to the generic exit-1 handler.
  async function fetchOrNetworkError(
    method: string,
    path: string,
    body: unknown,
    opts: FetchOptions
  ): Promise<Response> {
    try {
      return await doFetch(method, path, body, opts);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new CliError(`Network error: ${detail}`, 0, null, 7);
    }
  }

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: FetchOptions = {}
  ): Promise<T> {
    // Read-only write-lock: refuse every mutation before it leaves the process.
    // Mapped to exit 3 (forbidden) — the closest documented contract code for a
    // refused write. GETs pass through, so reads (and the read half of a
    // read-merge-write) still work.
    // `meta` requests (e.g. `ib feedback`) are not domain mutations — they are
    // whitelisted past the lock so feedback can be filed even under read-only.
    if (readOnly && method !== "GET" && !opts.meta && !opts.read) {
      // body.code surfaces as `code` in the stderr envelope — a machine-parseable
      // marker distinguishing this client-side refusal (statusCode 0) from a real
      // server-side HTTP 403, which shares exit code 3.
      throw new CliError(
        `Refused: '${method} ${path}' is a write and read-only mode is active (--read-only / IB_READ_ONLY).`,
        0,
        { code: "READ_ONLY_BLOCKED" },
        3
      );
    }
    // Announce the write target once, after the read-only gate (a refused write
    // must not claim to have acted) and before the request leaves the process.
    // Meta requests skip this — they don't write tenant data under any company lens.
    // Read-over-POST requests skip this — they don't mutate tenant data.
    if (method !== "GET" && !opts.meta && !opts.read) announceActingAs();
    const startedAt = Date.now();
    let res = await fetchOrNetworkError(method, path, body, opts);

    // Single-retry refresh path: only the first 401 triggers a refresh+retry.
    // A second consecutive 401 (post-refresh) falls through to the normal
    // error mapping so callers know to re-run `ib auth login`. A failing
    // refresh is itself an auth problem → CliError mapped to exit 2.
    if (res.status === 401 && onRefresh) {
      let newToken: string;
      try {
        newToken = await onRefresh(currentToken);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new CliError(detail, 401, null, 2);
      }
      currentToken = newToken;
      res = await fetchOrNetworkError(method, path, body, opts);
    }

    // Per-invocation timing for the global --stats flag (best-effort; never
    // alters the result). Records the round-trip incl. any refresh retry, plus
    // the backend's Server-Timing SQL metric when present.
    if (statsEnabled()) {
      recordRequest({ apiMs: Date.now() - startedAt, serverTiming: res.headers.get("Server-Timing") });
    }

    const contentType = res.headers.get("content-type") || "";
    // Guard the body parse: a non-OK response can carry an empty or malformed
    // body even with a JSON content-type — don't let a SyntaxError escape the
    // CliError mapping below.
    const parsed = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => "");
    if (!res.ok) {
      throw new CliError(
        errorMessageFromBody(parsed, res.status),
        res.status,
        parsed,
        exitCodeFromStatus(res.status)
      );
    }
    return parsed as T;
  }

  return {
    /**
     * The base URL this client targets. Exposed so callers can mint sibling
     * clients for the same endpoint with a different (e.g. ephemeral, per-
     * company) token — used by the `person search --my-companies` fan-out.
     */
    endpoint,
    get: <T = unknown>(path: string, opts?: FetchOptions) =>
      request<T>("GET", path, undefined, opts),
    post: <T = unknown>(path: string, body: unknown, opts?: FetchOptions) =>
      request<T>("POST", path, body, opts),
    put: <T = unknown>(path: string, body: unknown, opts?: FetchOptions) =>
      request<T>("PUT", path, body, opts),
    patch: <T = unknown>(path: string, body: unknown, opts?: FetchOptions) =>
      request<T>("PATCH", path, body, opts),
    delete: <T = unknown>(path: string, opts?: FetchOptions) =>
      request<T>("DELETE", path, undefined, opts),
    getCurrentToken: () => currentToken,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
