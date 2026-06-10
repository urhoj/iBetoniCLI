import { resolveAuth } from "./auth/resolve.js";
import { createApiClient, type ApiClient } from "./api/client.js";
import { createStore } from "./auth/store.js";
import { refreshToken } from "./auth/refresh.js";
import { performSwitch } from "./auth/switch.js";
import { decodeJwtPayload } from "./auth/jwt.js";
import type { GlobalOptions } from "./globals.js";

/** Outcome of {@link resolveEphemeralSwitch}: the token to act with + identity. */
export interface EphemeralSwitchResult {
  token: string;
  ownerAsiakasId: number | null;
  ownerAsiakasName?: string;
  /** True when a switch was performed (an ephemeral, non-persisted JWT). */
  switched: boolean;
}

/**
 * Decide which token a single invocation should act with, given an optional
 * global `--company <id>` target. When the target is absent or already the active
 * company, the base token is used unchanged (no network). Otherwise `switchFn`
 * mints a fresh JWT bound to the target tenant — an EPHEMERAL switch the caller
 * must NOT persist. `switchFn` failures (e.g. no access → CliError exit 3)
 * propagate to the caller.
 */
export async function resolveEphemeralSwitch(opts: {
  baseToken: string;
  baseOwnerAsiakasId: number | null;
  targetAsiakasId: number | undefined;
  switchFn: (
    toAsiakasId: number
  ) => Promise<{ jwt: string; ownerAsiakasId: number; ownerAsiakasName: string }>;
}): Promise<EphemeralSwitchResult> {
  const { baseToken, baseOwnerAsiakasId, targetAsiakasId, switchFn } = opts;
  if (targetAsiakasId === undefined || targetAsiakasId === baseOwnerAsiakasId) {
    return { token: baseToken, ownerAsiakasId: baseOwnerAsiakasId, switched: false };
  }
  const r = await switchFn(targetAsiakasId);
  return {
    token: r.jwt,
    ownerAsiakasId: r.ownerAsiakasId,
    ownerAsiakasName: r.ownerAsiakasName,
    switched: true,
  };
}

/**
 * Resolved per-invocation CLI context: an authenticated API client plus the
 * identity it represents.
 *
 * `client` is `null` when no auth could be resolved (no credentials file and
 * no `IB_TOKEN`); callers (`bin/ib.ts` `getClient`) translate that into a
 * clean "not logged in" exit-2 message.
 */
export interface CliContext {
  client: ApiClient | null;
  endpoint: string;
  personId: number | null;
  ownerAsiakasId: number | null;
}

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
export async function createCliContext(opts: {
  credentialsPath: string;
  version: string;
  global: GlobalOptions;
}): Promise<CliContext> {
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

  // Optional per-invocation global `--company <id>`: act in another company for this
  // one command without persisting the switch. Mints an ephemeral JWT bound to
  // the target tenant (the switch endpoint enforces access; no access → exit 3)
  // and is never written back to the credentials store.
  const eph = await resolveEphemeralSwitch({
    baseToken: auth.token,
    baseOwnerAsiakasId: auth.ownerAsiakasId,
    targetAsiakasId: opts.global.asiakas ?? undefined,
    switchFn: (toAsiakasId) =>
      performSwitch({ endpoint, jwt: auth.token, toAsiakasId }),
  });

  // Decode the active token (free, no network) so the client can announce the
  // write target on the first mutation. For an ephemeral switch the switch
  // response already names the company; otherwise decode the base token.
  // Best-effort — a malformed token must not break the client.
  let actingAs: { ownerAsiakasId: number; ownerAsiakasName?: string } | undefined;
  if (eph.switched && eph.ownerAsiakasId) {
    actingAs = {
      ownerAsiakasId: eph.ownerAsiakasId,
      ownerAsiakasName: eph.ownerAsiakasName,
    };
  } else {
    try {
      const claims = decodeJwtPayload(auth.token);
      if (claims.ownerAsiakasId) {
        actingAs = {
          ownerAsiakasId: claims.ownerAsiakasId,
          ownerAsiakasName: claims.ownerAsiakasName,
        };
      }
    } catch {
      // Undecodable token — skip the acting-as diagnostic.
    }
  }

  const client = createApiClient({
    endpoint,
    token: eph.token,
    version: opts.version,
    requestId: opts.global.requestId ?? undefined,
    readOnly: opts.global.readOnly,
    actingAs,
    quiet: opts.global.quiet,
    // Refresh-and-persist only for the normal (non-ephemeral) session. An
    // ephemeral `--company` token is single-command and bound to a different
    // company — persisting a refreshed copy would clobber the saved active
    // company, so it gets no refresh path (a 401 mid-command surfaces).
    onRefresh:
      auth.refreshable && !eph.switched
        ? async (currentJwt: string) => {
            const fresh = await refreshToken({ endpoint, currentJwt });
            const creds = await store.load();
            if (creds) await store.save({ ...creds, jwt: fresh });
            return fresh;
          }
        : undefined,
  });

  return {
    client,
    endpoint,
    personId: auth.personId,
    ownerAsiakasId: eph.ownerAsiakasId ?? auth.ownerAsiakasId,
  };
}
