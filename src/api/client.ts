import { randomUUID } from "node:crypto";
import { CliError, exitCodeFromStatus } from "./errors.js";

interface ApiClientOptions {
  endpoint: string;
  token: string;
  version: string;
  requestId?: string;
}

interface FetchOptions {
  headers?: Record<string, string>;
}

export function createApiClient({ endpoint, token, version, requestId }: ApiClientOptions) {
  const platform = `${process.platform} node-${process.versions.node}`;
  const userAgent = `ib-cli/${version} (${platform})`;

  function buildHeaders(
    extra: Record<string, string> = {},
    withBody = false
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
      "X-Request-ID": requestId || randomUUID(),
      ...(withBody ? { "Content-Type": "application/json" } : {}),
      ...extra,
    };
  }

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: FetchOptions = {}
  ): Promise<T> {
    const url = `${endpoint}${path}`;
    const withBody = method !== "GET" && body !== undefined;
    const res = await fetch(url, {
      method,
      headers: buildHeaders(opts.headers, withBody),
      body: withBody ? JSON.stringify(body) : undefined,
    });
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
