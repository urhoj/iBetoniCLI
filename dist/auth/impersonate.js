import { CliError, exitCodeFromStatus } from "../api/errors.js";
/** Reserved profile name under which the admin login is stashed during impersonation. */
export const IMPERSONATOR_PROFILE = "_impersonator";
async function postJson(endpoint, path, jwt, body, label) {
    let res;
    try {
        res = await fetch(`${endpoint}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
            body: JSON.stringify(body),
        });
    }
    catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new CliError(`Network error: ${detail}`, 0, null, 7);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new CliError(`${label} failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`, res.status, detail || null, exitCodeFromStatus(res.status));
    }
    return res.json().catch(() => ({}));
}
/** Mint a 10-minute impersonation JWT for the target (by personId OR email). */
export async function performImpersonate(opts) {
    const body = {};
    if (opts.email)
        body.email = opts.email;
    else
        body.personId = opts.personId;
    let data;
    try {
        data = (await postJson(opts.endpoint, "/api/auth/impersonate", opts.jwt, body, "Impersonate"));
    }
    catch (e) {
        // The backend returns the SAME 404 ("Kohdehenkilöä ei löytynyt") whether the
        // target does not exist OR exists but has an empty personEmail — the target
        // is resolved through the email-keyed login pipeline (getPersonDataFromEmail),
        // so an email-less person 404s indistinguishably from a missing one
        // (feedback #113). When the caller passed a personId (not --email), the raw
        // "not found" misleads — a valid personId reads as wrong — so surface BOTH
        // possibilities in the message and point at a verification step.
        if (e instanceof CliError && e.statusCode === 404 && opts.personId !== undefined && !opts.email) {
            throw new CliError(`Impersonate failed: personId ${opts.personId} could not be impersonated — it does not exist, OR it exists but has no personEmail (impersonation is email-keyed and requires one).`, 404, e.body, e.exitCode, `verify the target with \`ib person get ${opts.personId}\`; a person with no personEmail cannot be impersonated (set one first, or impersonate a different person)`);
        }
        throw e;
    }
    if (!data.token)
        throw new CliError("Impersonate failed: response missing token", 0, data, 1);
    return { token: data.token };
}
/** Renew the active impersonation session for 10 more minutes (needs the imp token). */
export async function performImpersonateExtend(opts) {
    const data = (await postJson(opts.endpoint, "/api/auth/impersonate/extend", opts.jwt, {}, "Extend"));
    if (!data.token)
        throw new CliError("Extend failed: response missing token", 0, data, 1);
    return { token: data.token };
}
/**
 * Write the impersonation_end audit row. Path A: call with the imp token.
 * Path B: call with the admin token + sessionId + targetPersonId (when the imp
 * token already expired client-side).
 */
export async function performImpersonateEnd(opts) {
    const body = { endReason: "manual" };
    if (opts.sessionId)
        body.sessionId = opts.sessionId;
    if (opts.targetPersonId)
        body.targetPersonId = opts.targetPersonId;
    await postJson(opts.endpoint, "/api/auth/impersonate/end", opts.jwt, body, "End");
    return { ok: true };
}
/** Build the credentials profile that represents an active impersonation session. */
export function buildImpersonationProfile(impToken, endpoint, decoded, nowIso) {
    return {
        jwt: impToken,
        refreshToken: "", // impersonation tokens have no refresh token
        issuedAt: nowIso,
        expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : nowIso,
        personId: decoded.personId ?? 0,
        ownerAsiakasId: decoded.ownerAsiakasId ?? 0,
        ownerAsiakasName: decoded.ownerAsiakasName ?? "",
        endpoint,
        impersonation: { actorPersonId: decoded.imp ?? 0, sessionId: decoded.imp_sid ?? "" },
    };
}
//# sourceMappingURL=impersonate.js.map