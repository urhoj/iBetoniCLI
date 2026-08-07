import { createStore } from "./store.js";
import { DEFAULT_ENDPOINT } from "../globals.js";
import { decodeJwtPayload, jwtShapeProblem } from "./jwt.js";
import { failWith } from "../output/json.js";
/**
 * Fold a bare access token into a `ResolvedAuth`. No refresh path, so nothing
 * derived from it is ever persisted. The JWT is decoded best-effort to surface
 * `personId` / `ownerAsiakasId`; a malformed token leaves both `null` and lets
 * the API 401 surface the real problem to the user.
 *
 * `fromEnv` marks the `IB_TOKEN` path, which is the one a HUMAN (or a script)
 * set by hand — there a value that isn't JWT-shaped is a typo/capture accident,
 * never a rejected credential, so it fails fast with a diagnostic instead of
 * paying a 401 round-trip that names the wrong cause (feedback #351). The
 * embedded caller's token stays best-effort: it comes from the server, so a 401
 * is the honest answer there.
 */
function bareTokenAuth(token, defaultEndpoint, fromEnv = false) {
    const shapeProblem = fromEnv ? jwtShapeProblem(token) : null;
    if (shapeProblem) {
        failWith(`IB_TOKEN is not a JWT: ${shapeProblem}`, 2, "check how IB_TOKEN was set — a command substitution (IB_TOKEN=$(…)) captures the command's WHOLE stdout, banner lines included; extract the token with `grep -oE 'eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'`");
    }
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
        return bareTokenAuth(process.env.IB_TOKEN, opts.defaultEndpoint, true);
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