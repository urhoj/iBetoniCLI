import { randomUUID } from "node:crypto";
import { CliError, exitCodeFromStatus } from "./errors.js";

/**
 * BetoniJerry umbrella tenant (`@ibetoni/constants` BETONIJERRY.OWNER_ASIAKAS_ID).
 * Writes resolved against it touch the shared umbrella org, so the acting-as
 * diagnostic flags it loudly. Inlined (stable tenant id) to keep the client
 * free of the CJS constants require on its hot path.
 */
const BETONIJERRY_UMBRELLA_ASIAKAS_ID = 1349;

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
   * the process prints a one-line stderr diagnostic naming the target company —
   * a guardrail against "wrong company lens" writes after a company switch.
   * Decoded from the JWT by the caller (free, no network). Suppressed by `quiet`.
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
      `[ib] write → asiakasId ${actingAs.ownerAsiakasId}${name}${umbrella}\n`
    );
  }

  function buildHeaders(
    extra: Record<string, string> = {},
    withBody = false
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${currentToken}`,
      "User-Agent": userAgent,
      "X-Request-ID": requestId || randomUUID(),
      ...(withBody ? { "Content-Type": "application/json" } : {}),
      ...extra,
    };
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

    const contentType = res.headers.get("content-type") || "";
    // Guard the body parse: a non-OK response can carry an empty or malformed
    // body even with a JSON content-type — don't let a SyntaxError escape the
    // CliError mapping below.
    const parsed = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => "");
    if (!res.ok) {
      throw new CliError(
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as { error: string }).error)
          : `HTTP ${res.status}`,
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
    delete: <T = unknown>(path: string, opts?: FetchOptions) =>
      request<T>("DELETE", path, undefined, opts),
    getCurrentToken: () => currentToken,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
