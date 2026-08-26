/**
 * The one authenticated JSON POST the auth flows share (impersonate, extend,
 * end, company switch). These deliberately bypass `createApiClient` — they run
 * before/around a usable client session — so the fetch + error mapping lived
 * copied in each flow until consolidated here.
 *
 * Contract: a network-level failure is a CliError exit 7; a non-2xx response is
 * `"<label> failed: HTTP <status><detail>"` with the status-mapped exit code; a
 * 2xx body that is not JSON degrades to `{}` (callers guard for the fields they
 * need, e.g. "response missing token").
 *
 * NOT for refresh.ts: its callers re-throw CliErrors through the client's
 * onRefresh path unchanged, and wrapping there would bypass the fb#195
 * "run `ib auth login`" hint.
 */
import { CliError, errorMessage, exitCodeFromStatus } from "../api/errors.js";
export async function postJson(endpoint, path, jwt, body, label) {
    let res;
    try {
        res = await fetch(`${endpoint}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
            body: JSON.stringify(body),
        });
    }
    catch (e) {
        const detail = errorMessage(e);
        throw new CliError(`Network error: ${detail}`, 0, null, 7);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new CliError(`${label} failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, detail || null, exitCodeFromStatus(res.status));
    }
    return res.json().catch(() => ({}));
}
//# sourceMappingURL=http.js.map