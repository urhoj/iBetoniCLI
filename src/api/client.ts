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

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: FetchOptions = {}
  ): Promise<T> {
    let res = await doFetch(method, path, body, opts);

    // Single-retry refresh path: only the first 401 triggers a refresh+retry.
    // A second consecutive 401 (post-refresh) falls through to the normal
    // error mapping so callers know to re-run `ib auth login`.
    if (res.status === 401 && onRefresh) {
      const newToken = await onRefresh(currentToken);
      currentToken = newToken;
      res = await doFetch(method, path, body, opts);
    }

    const contentType = res.headers.get("content-type") || "";
    const parsed = contentType.includes("application/json")
      ? await res.json()
      : await res.text();
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
