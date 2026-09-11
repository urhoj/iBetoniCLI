import { createStore, endpointKey, type CredentialsProfile } from "./store.js";

/**
 * fb#1624: under `--endpoint <slot sibling>` the store hands back the OTHER
 * slot's session (fb#1609), so a logout named for api-staging.ibetoni.fi would
 * revoke and delete the api.ibetoni.fi login it merely borrows. Returns the
 * stderr note to print INSTEAD of logging out, or null when the session really
 * is the requested endpoint's own.
 */
export function borrowedSessionNote(creds: CredentialsProfile, endpoint: string): string | null {
  const asked = endpointKey(endpoint);
  const own = endpointKey(creds.endpoint);
  return asked === own
    ? null
    : `[ib] note: no session of its own for ${asked} — it borrows the ${own} one, which stays; log that out with --endpoint ${creds.endpoint}`;
}

export interface LogoutOptions {
  endpoint: string;
  refreshToken: string;
  jwt: string;
  credentialsPath: string;
}

/**
 * Tear down ONE CLI session: best-effort revoke the refresh token at
 * `POST /oauth/revoke`, then unconditionally forget that endpoint's local
 * session (other endpoints' sessions stay — fb#855; the file goes with the
 * last one). Network failures are swallowed — the local session is always
 * removed so the user is logged out from this machine even when offline.
 */
export async function performLogout(opts: LogoutOptions): Promise<void> {
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
  } catch {
    // fail-open — still delete the local file
  }
  await createStore(opts.credentialsPath).removeEndpoint(opts.endpoint);
}
