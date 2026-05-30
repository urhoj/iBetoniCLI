import { createStore } from "./store.js";
/**
 * Tear down a CLI session: best-effort revoke the refresh token at
 * `POST /oauth/revoke`, then unconditionally delete the local credentials
 * file. Network failures are swallowed — the local file is always cleared
 * so the user is logged out from this machine even when offline.
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
    await createStore(opts.credentialsPath).clear();
}
//# sourceMappingURL=logout.js.map