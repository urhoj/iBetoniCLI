import { decodeJwtPayload } from "./jwt.js";
import { performSwitch } from "./switch.js";
import type { CredentialsProfile, CredentialsStore } from "./store.js";

export interface RefreshTokenOptions {
  endpoint: string;
  currentJwt: string;
}

interface RefreshResponse {
  token?: string;
  jwt?: string;
  access_token?: string;
}

/**
 * Exchange a (potentially near-expiry) JWT for a freshly issued one.
 *
 * Hits `POST /api/auth/refresh-token` with the current JWT as the
 * `Authorization: Bearer` header — the backend re-issues a token using the
 * same claims provided the original is still verifiable (within the grace
 * window). Throws on any non-200 response so the caller can fall back to the
 * OAuth refresh_token grant ({@link refreshSession}) or a full `ib auth login`.
 */
export async function refreshToken({
  endpoint,
  currentJwt,
}: RefreshTokenOptions): Promise<string> {
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
  const body = (await res.json()) as RefreshResponse;
  const newJwt = body.token ?? body.jwt ?? body.access_token;
  if (!newJwt || typeof newJwt !== "string") {
    throw new Error("Refresh failed: response missing token");
  }
  return newJwt;
}

export interface OAuthGrantResult {
  jwt: string;
  /** The ROTATED successor refresh token — the presented one is consumed
   * single-use server-side, so the caller MUST persist this one. */
  refreshToken: string;
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
export async function refreshViaOAuthGrant(opts: {
  endpoint: string;
  refreshToken: string;
  clientId?: string;
}): Promise<OAuthGrantResult> {
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
    throw new Error(
      `OAuth refresh-token grant failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`
    );
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token || typeof body.access_token !== "string") {
    throw new Error("OAuth refresh-token grant failed: response missing access_token");
  }
  return { jwt: body.access_token, refreshToken: body.refresh_token ?? "" };
}

export interface RefreshSessionResult {
  jwt: string;
  /** Present only when the OAuth grant ran — the rotated successor token. */
  refreshToken?: string;
}

/**
 * Refresh a session by whichever path can succeed: the JWT-bearer refresh
 * first (cheap, non-rotating — works while the JWT is still verifiable), then
 * the OAuth refresh_token grant when a stored refresh token exists (works even
 * after JWT expiry — the fb#258 dead-session case). Throws only when every
 * available path failed; the message names both failures so the caller knows
 * `ib auth login` is the only remaining recovery.
 */
export async function refreshSession(opts: {
  endpoint: string;
  currentJwt: string;
  storedRefreshToken?: string;
}): Promise<RefreshSessionResult> {
  let bearerError: unknown;
  try {
    return { jwt: await refreshToken({ endpoint: opts.endpoint, currentJwt: opts.currentJwt }) };
  } catch (e) {
    bearerError = e;
  }
  if (!opts.storedRefreshToken) throw bearerError;
  try {
    return await refreshViaOAuthGrant({
      endpoint: opts.endpoint,
      refreshToken: opts.storedRefreshToken,
    });
  } catch (grantError) {
    const bearer = bearerError instanceof Error ? bearerError.message : String(bearerError);
    const grant = grantError instanceof Error ? grantError.message : String(grantError);
    throw new Error(`${bearer}; ${grant} — session unrecoverable, run \`ib auth login\``);
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
 * `switchFn` is injectable for tests; defaults to {@link performSwitch}.
 */
export async function refreshAndPersistSession(opts: {
  endpoint: string;
  store: CredentialsStore;
  currentJwt: string;
  switchFn?: typeof performSwitch;
}): Promise<string> {
  const doSwitch = opts.switchFn ?? performSwitch;
  const creds = await opts.store.load();
  const session = await refreshSession({
    endpoint: opts.endpoint,
    currentJwt: opts.currentJwt,
    storedRefreshToken: creds?.refreshToken || undefined,
  });
  if (!creds) return session.jwt; // creds file vanished mid-run — nothing to persist to

  let claims: ReturnType<typeof decodeJwtPayload> | null = null;
  try {
    claims = decodeJwtPayload(session.jwt);
  } catch {
    // Undecodable fresh token — persist it anyway; the API will judge it.
  }
  let next: CredentialsProfile = {
    ...creds,
    jwt: session.jwt,
    ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
    ...(claims?.exp ? { expiresAt: new Date(claims.exp * 1000).toISOString() } : {}),
  };
  await opts.store.save(next);

  // Sticky-company guard: only needed when the fresh JWT's company differs
  // from the persisted active company (OAuth-grant path after a switch).
  if (
    claims?.ownerAsiakasId !== undefined &&
    creds.ownerAsiakasId &&
    claims.ownerAsiakasId !== creds.ownerAsiakasId
  ) {
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
    } catch {
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
