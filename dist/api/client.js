import { randomUUID } from "node:crypto";
import { CliError, exitCodeFromStatus } from "./errors.js";
export function createApiClient({ endpoint, token, version, requestId, onRefresh, }) {
    const platform = `${process.platform} node-${process.versions.node}`;
    const userAgent = `ib-cli/${version} (${platform})`;
    let currentToken = token;
    function buildHeaders(extra = {}, withBody = false) {
        return {
            Authorization: `Bearer ${currentToken}`,
            "User-Agent": userAgent,
            "X-Request-ID": requestId || randomUUID(),
            ...(withBody ? { "Content-Type": "application/json" } : {}),
            ...extra,
        };
    }
    async function doFetch(method, path, body, opts) {
        const url = `${endpoint}${path}`;
        const withBody = method !== "GET" && body !== undefined;
        return fetch(url, {
            method,
            headers: buildHeaders(opts.headers, withBody),
            body: withBody ? JSON.stringify(body) : undefined,
        });
    }
    async function request(method, path, body, opts = {}) {
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
            throw new CliError(typeof parsed === "object" && parsed && "error" in parsed
                ? String(parsed.error)
                : `HTTP ${res.status}`, res.status, parsed, exitCodeFromStatus(res.status));
        }
        return parsed;
    }
    return {
        get: (path, opts) => request("GET", path, undefined, opts),
        post: (path, body, opts) => request("POST", path, body, opts),
        put: (path, body, opts) => request("PUT", path, body, opts),
        delete: (path, opts) => request("DELETE", path, undefined, opts),
        getCurrentToken: () => currentToken,
    };
}
//# sourceMappingURL=client.js.map