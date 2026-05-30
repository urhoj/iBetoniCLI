import { resolveAuth } from "./auth/resolve.js";
import { createApiClient } from "./api/client.js";
import { createStore } from "./auth/store.js";
import { refreshToken } from "./auth/refresh.js";
/**
 * Build a `CliContext` for the current invocation.
 *
 * - Resolves auth via `resolveAuth` (env-var fallback first, then credentials
 *   file).
 * - For file-backed sessions, wires an `onRefresh` callback into the API
 *   client so a 401 transparently retries with a freshly minted JWT and the
 *   rotated token is persisted back to disk.
 * - Env-var (`IB_TOKEN`) sessions get no refresh path — a 401 surfaces.
 */
export async function createCliContext(opts) {
    const auth = await resolveAuth({
        credentialsPath: opts.credentialsPath,
        defaultEndpoint: opts.global.endpoint ?? undefined,
    });
    if (!auth) {
        return {
            client: null,
            endpoint: opts.global.endpoint ?? "https://api.ibetoni.fi",
            personId: null,
            ownerAsiakasId: null,
        };
    }
    const endpoint = opts.global.endpoint ?? auth.endpoint;
    const store = createStore(opts.credentialsPath);
    const client = createApiClient({
        endpoint,
        token: auth.token,
        version: opts.version,
        requestId: opts.global.requestId ?? undefined,
        onRefresh: auth.refreshable
            ? async (currentJwt) => {
                const fresh = await refreshToken({ endpoint, currentJwt });
                const creds = await store.load();
                if (creds)
                    await store.save({ ...creds, jwt: fresh });
                return fresh;
            }
            : undefined,
    });
    return {
        client,
        endpoint,
        personId: auth.personId,
        ownerAsiakasId: auth.ownerAsiakasId,
    };
}
//# sourceMappingURL=cliContext.js.map