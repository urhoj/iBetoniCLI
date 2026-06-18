import { createStore } from "./store.js";

/**
 * Resolved authentication for a CLI invocation.
 *
 * `source` distinguishes the credential origin:
 * - `"env"`  — token came from `IB_TOKEN`; treated as a bare access token with
 *              no refresh path (`refreshable: false`). Headless/CI use case.
 * - `"file"` — token loaded from the credentials store; can be refreshed via
 *              the stored `refreshToken`.
 */
export interface ResolvedAuth {
  token: string;
  endpoint: string;
  personId: number | null;
  ownerAsiakasId: number | null;
  source: "env" | "file";
  refreshable: boolean;
}

/**
 * Resolve auth for a CLI invocation, preferring the `IB_TOKEN` env var over
 * the on-disk credentials store. Returns `null` when neither is available —
 * the caller decides whether to prompt for `ib auth login` or fail.
 *
 * On `IB_TOKEN` the JWT is decoded best-effort to surface `personId` /
 * `ownerAsiakasId`; a malformed token leaves both as `null` and lets the API
 * 401 surface the real problem to the user.
 */
export async function resolveAuth(opts: {
  credentialsPath: string;
  defaultEndpoint?: string;
}): Promise<ResolvedAuth | null> {
  if (process.env.IB_TOKEN) {
    const { decodeJwtPayload } = await import("./jwt.js");
    let personId: number | null = null;
    let ownerAsiakasId: number | null = null;
    try {
      const claims = decodeJwtPayload(process.env.IB_TOKEN);
      personId = claims.personId ?? null;
      ownerAsiakasId = claims.ownerAsiakasId ?? null;
    } catch {
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
  if (!creds) return null;
  return {
    token: creds.jwt,
    endpoint: creds.endpoint,
    personId: creds.personId,
    ownerAsiakasId: creds.ownerAsiakasId,
    source: "file",
    refreshable: true,
  };
}
