import { createStore } from "./store.js";
/**
 * Tear down ONE CLI session: best-effort revoke the refresh token at
 * `POST /oauth/revoke`, then unconditionally forget that endpoint's local
 * session (other endpoints' sessions stay — fb#855; the file goes with the
 * last one). Network failures are swallowed — the local session is always
 * removed so the user is logged out from this machine even when offline.
 */
export async function performLogout(opts) {
    // Best-effort revoke; never throws.
    try {
        await fetch(`${opts.endpoint}/oauth/revoke`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${opts.jwt}`,
            },
            body: JSON.stringify({
                token: opts.refreshToken,
                token_type_hint: "refresh_token",
            }),
        });
    }
    catch {
        // fail-open — still delete the local file
    }
    await createStore(opts.credentialsPath).removeEndpoint(opts.endpoint);
}
//# sourceMappingURL=logout.js.map