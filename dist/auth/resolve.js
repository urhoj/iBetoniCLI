import { createStore } from "./store.js";
import { DEFAULT_ENDPOINT } from "../globals.js";
import { decodeJwtPayload } from "./jwt.js";
/**
 * Fold a bare access token into a `ResolvedAuth`. No refresh path, so nothing
 * derived from it is ever persisted. The JWT is decoded best-effort to surface
 * `personId` / `ownerAsiakasId`; a malformed token leaves both `null` and lets
 * the API 401 surface the real problem to the user.
 */
function bareTokenAuth(token, defaultEndpoint) {
    let personId = null;
    let ownerAsiakasId = null;
    try {
        const claims = decodeJwtPayload(token);
        personId = claims.personId ?? null;
        ownerAsiakasId = claims.ownerAsiakasId ?? null;
    }
    catch {
        // Malformed token — caller will get 401 from API and exit.
    }
    return {
        token,
        endpoint: defaultEndpoint ?? DEFAULT_ENDPOINT,
        personId,
        ownerAsiakasId,
        source: "env",
        refreshable: false,
    };
}
/**
 * Resolve auth for a CLI invocation: an explicitly supplied `token` wins, then
 * the `IB_TOKEN` env var, then the on-disk credentials store. Returns `null`
 * when none is available — the caller decides whether to prompt for
 * `ib auth login` or fail.
 */
export async function resolveAuth(opts) {
    // Tested with `!== undefined`, not truthiness: an explicitly supplied token is
    // authoritative even when empty, so an embedded caller who sent no token gets a
    // 401 instead of silently acting as the HOST's credentials.
    if (opts.token !== undefined)
        return bareTokenAuth(opts.token, opts.defaultEndpoint);
    if (process.env.IB_TOKEN)
        return bareTokenAuth(process.env.IB_TOKEN, opts.defaultEndpoint);
    const creds = await createStore(opts.credentialsPath).load();
    if (!creds)
        return null;
    return {
        token: creds.jwt,
        endpoint: creds.endpoint,
        personId: creds.personId,
        ownerAsiakasId: creds.ownerAsiakasId,
        source: "file",
        refreshable: true,
    };
}
//# sourceMappingURL=resolve.js.map