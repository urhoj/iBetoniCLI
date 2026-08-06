import { createStore } from "./store.js";
import { DEFAULT_ENDPOINT } from "../globals.js";
import { decodeJwtPayload } from "./jwt.js";

/**
 * Resolved authentication for a CLI invocation.
 *
 * `source` distinguishes the credential origin:
 * - `"env"`  — a bare access token (`IB_TOKEN`, or the caller's JWT supplied by
 *              the embedded in-process path) with no refresh path
 *              (`refreshable: false`). Headless/CI and server-side exec.
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
 * Fold a bare access token into a `ResolvedAuth`. No refresh path, so nothing
 * derived from it is ever persisted. The JWT is decoded best-effort to surface
 * `personId` / `ownerAsiakasId`; a malformed token leaves both `null` and lets
 * the API 401 surface the real problem to the user.
 */
function bareTokenAuth(token: string, defaultEndpoint?: string): ResolvedAuth {
  let personId: number | null = null;
  let ownerAsiakasId: number | null = null;
  try {
    const claims = decodeJwtPayload(token);
    personId = claims.personId ?? null;
    ownerAsiakasId = claims.ownerAsiakasId ?? null;
  } catch {
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
export async function resolveAuth(opts: {
  credentialsPath: string;
  defaultEndpoint?: string;
  /**
   * A pre-resolved bearer token that WINS over `IB_TOKEN` and the credentials
   * file. Supplied by the embedded in-process path (`/api/cli/exec` with
   * `IB_EXEC_INPROCESS`) so commands act with the CALLER's JWT rather than the
   * host process's own credentials. Treated exactly like `IB_TOKEN` —
   * non-refreshable, so nothing is ever persisted on the caller's behalf.
   */
  token?: string;
}): Promise<ResolvedAuth | null> {
  // Tested with `!== undefined`, not truthiness: an explicitly supplied token is
  // authoritative even when empty, so an embedded caller who sent no token gets a
  // 401 instead of silently acting as the HOST's credentials.
  if (opts.token !== undefined) return bareTokenAuth(opts.token, opts.defaultEndpoint);
  if (process.env.IB_TOKEN) return bareTokenAuth(process.env.IB_TOKEN, opts.defaultEndpoint);
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
