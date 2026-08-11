import { createStore } from "./store.js";
import { DEFAULT_ENDPOINT } from "../globals.js";
import { decodeJwtPayload, jwtShapeProblem } from "./jwt.js";
import { failWith } from "../output/json.js";

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
 *
 * `fromEnv` marks the `IB_TOKEN` path, which is the one a HUMAN (or a script)
 * set by hand — there a value that isn't JWT-shaped is a typo/capture accident,
 * never a rejected credential, so it fails fast with a diagnostic instead of
 * paying a 401 round-trip that names the wrong cause (feedback #351). The
 * embedded caller's token stays best-effort: it comes from the server, so a 401
 * is the honest answer there.
 */
function bareTokenAuth(
  token: string,
  defaultEndpoint?: string,
  fromEnv = false
): ResolvedAuth {
  const shapeProblem = fromEnv ? jwtShapeProblem(token) : null;
  if (shapeProblem) {
    failWith(
      `IB_TOKEN is not a JWT: ${shapeProblem}`,
      2,
      token === ""
        ? // The opposite capture accident from the one below: the command printed
          // NOTHING to stdout, so there are no banner lines to strip — the minting
          // step itself failed (wrong directory, missing env, non-zero exit) and
          // its diagnostic went to stderr, which `$(…)` does not capture (fb#420).
          "IB_TOKEN is set but empty — the command that produced it wrote nothing to stdout; run that command on its own (without 2>/dev/null) and read its stderr"
        : "check how IB_TOKEN was set — a command substitution (IB_TOKEN=$(…)) captures the command's WHOLE stdout, banner lines included; extract the token with `grep -oE 'eyJ[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'`"
    );
  }
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
  // Same `!== undefined` reasoning, for the same reason: SETTING the variable is
  // the caller declaring headless intent, so an empty value is a broken minting
  // step, never a request to fall back to interactive credentials. Under
  // truthiness this silently used the credentials file and any staleness there
  // surfaced as "session unrecoverable, run `ib auth login`" — a diagnostic
  // pointing at the wrong subsystem entirely (fb#420).
  if (process.env.IB_TOKEN !== undefined)
    return bareTokenAuth(process.env.IB_TOKEN, opts.defaultEndpoint, true);
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
