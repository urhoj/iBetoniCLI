import { errorMessage } from "../api/errors.js";
import { decodeJwtPayload } from "./jwt.js";
import { performSwitch } from "./switch.js";
/**
 * Exchange a (potentially near-expiry) JWT for a freshly issued one.
 *
 * Hits `POST /api/auth/refresh-token` with the current JWT as the
 * `Authorization: Bearer` header — the backend re-issues a token using the
 * same claims provided the original is still verifiable (within the grace
 * window). Throws on any non-200 response so the caller can fall back to the
 * OAuth refresh_token grant ({@link refreshSession}) or a full `ib auth login`.
 */
export async function refreshToken({ endpoint, currentJwt, }) {
    const res = await fetch(`${endpoint}/api/auth/refresh-token`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${currentJwt}`,
            "Content-Type": "application/json",
        },
    });
    if (res.status !== 200) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Refresh failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    const body = (await res.json());
    const newJwt = body.token ?? body.jwt ?? body.access_token;
    if (!newJwt || typeof newJwt !== "string") {
        throw new Error("Refresh failed: response missing token");
    }
    return newJwt;
}
/**
 * Redeem the stored OAuth refresh token for a fresh JWT via
 * `POST /oauth/token` (`grant_type=refresh_token`, public client `ib-cli`).
 *
 * Unlike the JWT-bearer refresh this works AFTER the JWT has expired — the
 * refresh token has its own 90-day sliding TTL. Tokens are rotating with
 * reuse-detection: the presented token is consumed and a successor is issued;
 * replaying a consumed token revokes the whole family. So on success the
 * returned `refreshToken` must be persisted immediately.
 */
export async function refreshViaOAuthGrant(opts) {
    const res = await fetch(`${opts.endpoint}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: opts.refreshToken,
            client_id: opts.clientId ?? "ib-cli",
        }),
    });
    if (res.status !== 200) {
        const detail = await res.text().catch(() => "");
        throw new Error(`OAuth refresh-token grant failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    const body = (await res.json());
    if (!body.access_token || typeof body.access_token !== "string") {
        throw new Error("OAuth refresh-token grant failed: response missing access_token");
    }
    return { jwt: body.access_token, refreshToken: body.refresh_token ?? "" };
}
/**
 * Refresh a session by whichever path can succeed: the JWT-bearer refresh
 * first (cheap, non-rotating — works while the JWT is still verifiable), then
 * the OAuth refresh_token grant when a stored refresh token exists (works even
 * after JWT expiry — the fb#258 dead-session case). Throws only when every
 * available path failed; the message names both failures so the caller knows
 * `ib auth login` is the only remaining recovery.
 */
export async function refreshSession(opts) {
    let bearerError;
    try {
        return { jwt: await refreshToken({ endpoint: opts.endpoint, currentJwt: opts.currentJwt }) };
    }
    catch (e) {
        bearerError = e;
    }
    if (!opts.storedRefreshToken)
        throw bearerError;
    try {
        return await refreshViaOAuthGrant({
            endpoint: opts.endpoint,
            refreshToken: opts.storedRefreshToken,
        });
    }
    catch (grantError) {
        const bearer = errorMessage(bearerError);
        const grant = errorMessage(grantError);
        throw new Error(`${bearer}; ${grant} — session unrecoverable, run \`ib auth login\``, { cause: grantError });
    }
}
/**
 * Full self-heal for a FILE session: {@link refreshSession}, persist the result
 * IMMEDIATELY (the OAuth grant consumes the presented refresh token — a crash
 * before persist would orphan the rotation and trip reuse-detection, revoking
 * the family), then re-assert the persisted active company. The grant re-mints
 * the LOGIN-time company, so if the user has since `auth switch`ed, the fresh
 * JWT is switched back before the session continues — no silent tenant flip.
 * Returns the JWT to act with.
 *
 * SERIALIZED cross-process (fb#884): the whole heal runs under the store's
 * file lock, and the credentials are re-read FRESH after acquiring it. Two
 * concurrent `ib` processes used to both read the same rotating refresh token
 * and both run the grant — the loser tripped the server's reuse detection,
 * which revokes the ENTIRE session family and bricks unattended automation
 * until a human browser-login. Under the lock the winner refreshes and the
 * waiter finds the rotated JWT already on disk (the `creds.jwt !==
 * opts.currentJwt` short-circuit) and never touches the network. A writer
 * that does not honour the lock (an older globally-linked `ib`) is caught by
 * the reuse-recovery re-read in the catch below.
 *
 * `switchFn` is injectable for tests; defaults to {@link performSwitch}.
 */
export async function refreshAndPersistSession(opts) {
    return opts.store.withLock(() => refreshAndPersistLocked(opts));
}
/** The locked body of {@link refreshAndPersistSession} — never call directly. */
async function refreshAndPersistLocked(opts) {
    const doSwitch = opts.switchFn ?? performSwitch;
    let creds = await opts.store.reload();
    // Another process refreshed while we waited on the lock — its rotated
    // session is already persisted; running the grant ourselves would present a
    // CONSUMED token. If this JWT is somehow also bad, the client's single-retry
    // 401 surfaces cleanly.
    if (creds?.jwt && creds.jwt !== opts.currentJwt)
        return creds.jwt;
    let session;
    try {
        session = await refreshSession({
            endpoint: opts.endpoint,
            currentJwt: opts.currentJwt,
            storedRefreshToken: creds?.refreshToken || undefined,
        });
    }
    catch (refreshError) {
        // Reuse-detection recovery: a concurrent writer that bypassed the lock may
        // have rotated the credentials underneath us. Re-read ONCE — prefer a
        // fresher persisted JWT outright, or retry the grant with the rotated
        // refresh token — before declaring the session dead.
        const latest = await opts.store.reload();
        if (latest?.jwt && latest.jwt !== opts.currentJwt)
            return latest.jwt;
        if (latest?.refreshToken && latest.refreshToken !== creds?.refreshToken) {
            session = await refreshSession({
                endpoint: opts.endpoint,
                currentJwt: opts.currentJwt,
                storedRefreshToken: latest.refreshToken,
            });
            creds = latest;
        }
        else {
            throw refreshError;
        }
    }
    if (!creds)
        return session.jwt; // creds file vanished mid-run — nothing to persist to
    let claims = null;
    try {
        claims = decodeJwtPayload(session.jwt);
    }
    catch {
        // Undecodable fresh token — persist it anyway; the API will judge it.
    }
    let next = {
        ...creds,
        jwt: session.jwt,
        ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
        ...(claims?.exp ? { expiresAt: new Date(claims.exp * 1000).toISOString() } : {}),
    };
    await opts.store.save(next);
    // Sticky-company guard: only needed when the fresh JWT's company differs
    // from the persisted active company (OAuth-grant path after a switch).
    if (claims?.ownerAsiakasId !== undefined &&
        creds.ownerAsiakasId &&
        claims.ownerAsiakasId !== creds.ownerAsiakasId) {
        try {
            const sw = await doSwitch({
                endpoint: opts.endpoint,
                jwt: session.jwt,
                toAsiakasId: creds.ownerAsiakasId,
            });
            next = {
                ...next,
                jwt: sw.jwt,
                ownerAsiakasId: sw.ownerAsiakasId,
                ownerAsiakasName: sw.ownerAsiakasName,
            };
        }
        catch {
            // Membership to the old active company revoked since login — keep the
            // fresh JWT and make the creds file state the ACTUAL company instead of
            // lying about a tenant we can no longer act as.
            next = {
                ...next,
                ownerAsiakasId: claims.ownerAsiakasId,
                ownerAsiakasName: claims.ownerAsiakasName ?? "",
            };
        }
        await opts.store.save(next);
    }
    return next.jwt;
}
//# sourceMappingURL=refresh.js.map