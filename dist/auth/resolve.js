import { createStore } from "./store.js";
/**
 * Resolve auth for a CLI invocation, preferring the `IB_TOKEN` env var over
 * the on-disk credentials store. Returns `null` when neither is available —
 * the caller decides whether to prompt for `ib auth login` or fail.
 *
 * On `IB_TOKEN` the JWT is decoded best-effort to surface `personId` /
 * `ownerAsiakasId`; a malformed token leaves both as `null` and lets the API
 * 401 surface the real problem to the user.
 */
export async function resolveAuth(opts) {
    if (process.env.IB_TOKEN) {
        const { decodeJwtPayload } = await import("./jwt.js");
        let personId = null;
        let ownerAsiakasId = null;
        try {
            const claims = decodeJwtPayload(process.env.IB_TOKEN);
            personId = Number.isFinite(claims.personId) ? claims.personId : null;
            ownerAsiakasId = Number.isFinite(claims.ownerAsiakasId) ? claims.ownerAsiakasId : null;
        }
        catch {
            // Malformed token — caller will get 401 from API and exit.
        }
        return {
            token: process.env.IB_TOKEN,
            endpoint: opts.defaultEndpoint ?? "https://api.ibetoni.fi",
            personId,
            ownerAsiakasId,
            source: "env",
            refreshable: false,
        };
    }
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