import { resolveAuth } from "./auth/resolve.js";
import { createApiClient, type ApiClient } from "./api/client.js";
import { createStore } from "./auth/store.js";
import { refreshAndPersistSession } from "./auth/refresh.js";
import { performSwitch } from "./auth/switch.js";
import { decodeJwtPayload } from "./auth/jwt.js";
import { CliError } from "./api/errors.js";
import { DEFAULT_ENDPOINT, type GlobalOptions } from "./globals.js";

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

const normalizeEndpoint = (u: string) => u.replace(/\/+$/, "").toLowerCase();

/**
 * The one "this 401 means WRONG ENDPOINT for this token, not expired session"
 * diagnostic (fb#465).
 *
 * A file-backed session is endpoint-specific — its JWT and refresh token were
 * minted by the stored endpoint. Under a `--endpoint` override a 401 elsewhere
 * means the token does not belong there: refreshing against the override fails
 * (different JWT_KEY), and if the keys happened to match it would persist a
 * foreign-minted JWT into the stored profile. The generic remedy ("session
 * unrecoverable, run `ib auth login`") names the wrong cause and throws away a
 * session that is still valid on its own endpoint.
 *
 * Raised from BOTH places a mismatched session can 401 (fb#484):
 *  - the refresh-on-401 callback, i.e. the command's own request; and
 *  - the global `--company` ephemeral switch, which calls performSwitch with the
 *    stored token BEFORE the API client and its refresh callback exist, so it
 *    could never reach the callback above.
 *
 * Client-origin (`statusCode` 0): the 401 itself came from the server, but THIS
 * error is locally fabricated — see test/api/client-origin-status.test.ts.
 */
function endpointMismatchError(opts: {
  /** The endpoint the request actually went to (the `--endpoint` override). */
  requestEndpoint: string;
  /** The endpoint the stored session was minted against. */
  sessionEndpoint: string;
  /** What 401'd, when it was not the command's own request. */
  during?: string;
}): CliError {
  const what = opts.during ? `${opts.during}: 401` : "401";
  return new CliError(
    `${what} from ${opts.requestEndpoint}, but the stored session was minted against ${opts.sessionEndpoint} — a token is endpoint-specific (the stored session is likely still valid on its own endpoint)`,
    0,
    null,
    2,
    `authenticate against this endpoint with \`ib auth login --endpoint ${opts.requestEndpoint}\`, or set IB_TOKEN to a token minted for it (local backend: \`node puminet5api/utils/test/mint-local-token.js\`)`
  );
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
 * - Resolves auth via `resolveAuth` (`embeddedToken` first, then the env var,
 *   then the credentials file).
 * - For file-backed sessions, wires an `onRefresh` callback into the API
 *   client so a 401 transparently retries with a freshly minted JWT and the
 *   rotated token is persisted back to disk.
 * - Bare-token (`IB_TOKEN` / embedded) sessions get no refresh path — a 401
 *   surfaces, and nothing is ever written to the credentials file.
 */
export async function createCliContext(opts: {
  credentialsPath: string;
  version: string;
  global: GlobalOptions;
  /**
   * The embedded caller's JWT when this process is serving an in-process
   * `/api/cli/exec` call. Replaces credential resolution entirely, so every
   * client this context mints — including the ephemeral per-company ones — is
   * bound to the CALLER's identity, and the host's credentials file is neither
   * read nor written. Absent in normal CLI mode.
   */
  embeddedToken?: string;
}): Promise<CliContext> {
  const auth = await resolveAuth({
    credentialsPath: opts.credentialsPath,
    defaultEndpoint: opts.global.endpoint ?? undefined,
    token: opts.embeddedToken,
  });
  if (!auth) {
    return {
      client: null,
      endpoint: opts.global.endpoint ?? DEFAULT_ENDPOINT,
      personId: null,
      ownerAsiakasId: null,
    };
  }

  const endpoint = opts.global.endpoint ?? auth.endpoint;
  const store = createStore(opts.credentialsPath);

  // Computed BEFORE the ephemeral switch below, not after (fb#484): the switch is
  // the FIRST network call of the invocation, so it is the first thing that can
  // 401 on a mismatched endpoint — and it runs with the stored token, ahead of the
  // API client that carries the refresh-path copy of this diagnostic.
  const endpointMismatch =
    auth.source === "file" &&
    opts.global.endpoint != null &&
    normalizeEndpoint(opts.global.endpoint) !== normalizeEndpoint(auth.endpoint);

  // Optional per-invocation global `--company <id>`: act in another company for this
  // one command without persisting the switch. Mints an ephemeral JWT bound to
  // the target tenant (the switch endpoint enforces access; no access → exit 3)
  // and is never written back to the credentials store.
  let eph: EphemeralSwitchResult;
  try {
    eph = await resolveEphemeralSwitch({
      baseToken: auth.token,
      baseOwnerAsiakasId: auth.ownerAsiakasId,
      targetAsiakasId: opts.global.asiakas ?? undefined,
      switchFn: (toAsiakasId) =>
        performSwitch({ endpoint, jwt: auth.token, toAsiakasId }),
    });
  } catch (e) {
    // `--company <id>` switches your ACTING IDENTITY to a company you are a MEMBER
    // of. A 403 here usually means you passed a customer your active company merely
    // OWNS (e.g. one you just created) — that is a write TARGET, not an identity.
    // Point the caller at the per-command `--asiakas` flag instead of the generic
    // permission-denied hint.
    if (e instanceof CliError && e.statusCode === 403) {
      throw new CliError(
        `${e.message} — note: --company switches to a company you are a MEMBER of; to act on a ` +
          `customer your active company OWNS (e.g. just created), use that command's --asiakas <id> ` +
          `flag instead of the global --company.`,
        e.statusCode,
        e.body,
        e.exitCode,
        // Empty hint = SUPPRESS the running command's spec remedy. This 403 came
        // from the global --company lens switch, BEFORE the command called its own
        // endpoint, so the leaf's HTTP 403 row is a false lead (`ib person search
        // --company <id>` answered a switch failure with "check auth.page.person.read"
        // — feedback #311). The message above is already the full remedy.
        ""
      );
    }
    // A 401 here is the endpoint-mismatch case, NOT an expired session (fb#484).
    // performSwitch ran against the OVERRIDE endpoint with a token the STORED
    // endpoint minted, so the generic 401 remedy ("run `ib auth refresh`") sends
    // the caller to refresh a session that is fine — the same wrong-cause framing
    // fb#465 removed from the command's own request path.
    if (e instanceof CliError && e.statusCode === 401 && endpointMismatch) {
      throw endpointMismatchError({
        requestEndpoint: endpoint,
        sessionEndpoint: auth.endpoint,
        during: "--company switch",
      });
    }
    throw e;
  }

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

  // An impersonation session (JWT carries `imp`) must NOT use the standard
  // refresh path: /api/auth/refresh-token re-derives DB claims and DROPS
  // imp/imp_sid + the 10-min cap, silently escalating a 10-minute impersonation
  // into a permanent login as the target. Disable auto-refresh for these
  // sessions — a 401 surfaces cleanly and the user re-runs `ib auth impersonate`
  // (or `ib auth impersonate --extend`).
  let isImpersonating = false;
  try {
    isImpersonating = decodeJwtPayload(auth.token).imp !== undefined;
  } catch {
    // Undecodable token — treat as a normal session.
  }

  const client = createApiClient({
    endpoint,
    token: eph.token,
    version: opts.version,
    requestId: opts.global.requestId ?? undefined,
    readOnly: opts.global.readOnly,
    actingAs,
    quiet: opts.global.quiet,
    verbose: opts.global.verbose,
    // Refresh-and-persist only for the normal (non-ephemeral) session. An
    // ephemeral `--company` token is single-command and bound to a different
    // company — persisting a refreshed copy would clobber the saved active
    // company, so it gets no refresh path (a 401 mid-command surfaces).
    // refreshAndPersistSession falls back to the OAuth refresh_token grant when
    // the JWT-bearer refresh fails (fb#258: heals a session whose JWT lapsed),
    // persisting the rotated refresh token + expiry alongside the fresh JWT.
    // On an `--endpoint` override differing from the stored session's endpoint
    // the callback instead raises the endpoint-mismatch diagnostic (fb#465).
    onRefresh:
      auth.refreshable && !eph.switched && !isImpersonating
        ? endpointMismatch
          ? async () => {
              throw endpointMismatchError({
                requestEndpoint: endpoint,
                sessionEndpoint: auth.endpoint,
              });
            }
          : (currentJwt: string) => refreshAndPersistSession({ endpoint, store, currentJwt })
        : undefined,
  });

  return {
    client,
    endpoint,
    personId: auth.personId,
    ownerAsiakasId: eph.ownerAsiakasId ?? auth.ownerAsiakasId,
  };
}
