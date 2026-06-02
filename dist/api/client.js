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
    // A fetch rejection (DNS failure, connection refused, TLS error, …) is a
    // network problem, not an HTTP status — surface it as a CliError mapped to
    // the documented `7` network exit code instead of letting a raw TypeError
    // escape to the generic exit-1 handler.
    async function fetchOrNetworkError(method, path, body, opts) {
        try {
            return await doFetch(method, path, body, opts);
        }
        catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            throw new CliError(`Network error: ${detail}`, 0, null, 7);
        }
    }
    async function request(method, path, body, opts = {}) {
        let res = await fetchOrNetworkError(method, path, body, opts);
        // Single-retry refresh path: only the first 401 triggers a refresh+retry.
        // A second consecutive 401 (post-refresh) falls through to the normal
        // error mapping so callers know to re-run `ib auth login`. A failing
        // refresh is itself an auth problem → CliError mapped to exit 2.
        if (res.status === 401 && onRefresh) {
            let newToken;
            try {
                newToken = await onRefresh(currentToken);
            }
            catch (e) {
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