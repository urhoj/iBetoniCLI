import { randomUUID } from "node:crypto";
import { CliError, exitCodeFromStatus } from "./errors.js";

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
}

interface FetchOptions {
  headers?: Record<string, string>;
}

export function createApiClient({
  endpoint,
  token,
  version,
  requestId,
  onRefresh,
}: ApiClientOptions) {
  const platform = `${process.platform} node-${process.versions.node}`;
  const userAgent = `ib-cli/${version} (${platform})`;
  let currentToken = token;

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
