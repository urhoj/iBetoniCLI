import type { Command } from "commander";
import { getGlobalOptions, DEFAULT_ENDPOINT } from "../../globals.js";
import { createStore, defaultCredentialsPath } from "../../auth/store.js";
import { performLogin } from "../../auth/login.js";
import { performLogout } from "../../auth/logout.js";
import { renderWhoami } from "../../auth/whoami.js";
import {
  assertPersistedSwitchAllowed,
  runPersistedSwitch,
} from "../../auth/switch.js";
import { refreshAndPersistSession } from "../../auth/refresh.js";
import { decodeJwtPayload, impersonationFromClaims } from "../../auth/jwt.js";
import { resolveAuth } from "../../auth/resolve.js";
import { resolveCallerTier } from "../../tier.js";
import { CliError } from "../../api/errors.js";
import { guarded } from "../_shared/action.js";
import {
  performImpersonate,
  performImpersonateExtend,
  performImpersonateEnd,
  buildImpersonationProfile,
  IMPERSONATOR_PROFILE,
} from "../../auth/impersonate.js";
import { writeJson, failWith, errorMessage } from "../../output/json.js";
import { intFlag, parseId } from "../../targets.js";

/**
 * Register `ib auth` subcommands on the parent commander instance:
 *   - login    OAuth 2.1 + PKCE flow with local 127.0.0.1 callback
 *   - logout   best-effort /oauth/revoke + delete local credentials
 *   - whoami   print the active credentials profile
 *   - switch   change active company and persist the rotated JWT
 *   - refresh  manually refresh the JWT and persist
 *
 * Exit codes: 2 = auth-related failure (not logged in, bad credentials,
 * unrecoverable OAuth flow); 1 = generic failure.
 *
 * `isReadOnly` resolves the session write-lock at action time: `auth switch`
 * persists a rotated JWT, so it is refused (exit 3) under read-only mode.
 */
export function registerAuthCommands(
  parent: Command,
  isReadOnly: () => boolean
): void {
  const auth = parent.command("auth").description("Authentication commands");

  auth
    .command("login")
    // No LOCAL --endpoint option: the root global `--endpoint` claims the value
    // during parse (Commander recognises root options anywhere), so a local
    // duplicate silently fell back to its default — `auth login --endpoint
    // <staging>` authorized against PROD. Read the global instead.
    .action(
      guarded(async () => {
        try {
          await performLogin({
            endpoint: getGlobalOptions(parent).endpoint ?? DEFAULT_ENDPOINT,
            credentialsPath: defaultCredentialsPath(),
          });
        } catch (e) {
          // Anything that goes wrong in the OAuth flow is an auth failure —
          // re-raised as a CliError so `guarded` reports it, instead of the old
          // bare `process.exitCode = 2` that an in-process (EmbeddedCtx) caller
          // never saw. `guarded` also keeps the Windows-safe "never
          // process.exit() post-fetch" rule.
          failWith(errorMessage(e), 2);
        }
      })
    );

  auth
    .command("logout")
    .action(
      guarded(async () => {
        try {
          const store = createStore(defaultCredentialsPath());
          const creds = await store.load();
          if (!creds) {
            // Not logged in — no-op success.
            return;
          }
          await performLogout({
            endpoint: creds.endpoint,
            refreshToken: creds.refreshToken,
            jwt: creds.jwt,
            credentialsPath: defaultCredentialsPath(),
          });
        } catch (e) {
          // Generic exit 1 — a best-effort revoke that fails is not an auth
          // problem. Raised as a CliError so `guarded` records it (see login).
          failWith(errorMessage(e), 1);
        }
      })
    );

  auth
    .command("whoami")
    .action(
      guarded(async () => {
        // resolveAuth (IB_TOKEN-or-file) — so whoami works for headless/CI
        // sessions too, not just the on-disk creds store.
        const resolved = await resolveAuth({
          credentialsPath: defaultCredentialsPath(),
          defaultEndpoint: getGlobalOptions(parent).endpoint ?? undefined,
        });
        if (!resolved) {
          failWith("Not logged in. Run `ib auth login` first (or set IB_TOKEN).", 2);
          return;
        }
        const store = createStore(defaultCredentialsPath());
        let token = resolved.token;
        let claims = decodeJwtPayload(token);
        // Impersonation marker lives on the creds profile (file sessions);
        // renderWhoami falls back to the JWT imp claims for IB_TOKEN sessions.
        const profile = resolved.source === "file" ? await store.load() : null;
        let refreshed = false;

        // A dead session must be caught HERE, at the orientation read — not on
        // the next write (fb#258). Expired file sessions self-heal (bearer
        // refresh → OAuth refresh_token grant); anything unrecoverable exits 2.
        if (claims.exp != null && claims.exp * 1000 < Date.now()) {
          const expiredAt = new Date(claims.exp * 1000).toISOString();
          if (resolved.source === "env") {
            failWith(
              `IB_TOKEN is expired (since ${expiredAt}) and non-refreshable`,
              2,
              "mint a fresh JWT and update IB_TOKEN"
            );
          }
          if (profile?.impersonation ?? impersonationFromClaims(claims)) {
            failWith(
              `impersonation session expired (since ${expiredAt})`,
              2,
              "run `ib auth impersonate --end` to restore your own login, or re-impersonate"
            );
          }
          try {
            token = await refreshAndPersistSession({
              endpoint: resolved.endpoint,
              store,
              currentJwt: token,
            });
            claims = decodeJwtPayload(token);
            refreshed = true;
          } catch (e) {
            failWith(
              `session expired (since ${expiredAt}) and unrefreshable: ${errorMessage(e)}`,
              2,
              "run `ib auth login` to re-authenticate"
            );
          }
        }

        const tier = resolveCallerTier(token);
        const out = renderWhoami({
          claims,
          endpoint: resolved.endpoint,
          source: resolved.source,
          readOnly: isReadOnly(),
          tier,
          impersonation: profile?.impersonation,
        });
        if (refreshed) out.refreshed = true;
        writeJson(out);
      })
    );

  auth
    .command("switch")
    .requiredOption("--to <asiakasId>", "", intFlag("--to"))
    .action(
      guarded(async (opts: { to: number }) => {
        writeJson(await runPersistedSwitch(opts.to, isReadOnly()));
      })
    );

  auth
    .command("refresh")
    .action(
      guarded(async () => {
        try {
          const store = createStore(defaultCredentialsPath());
          const creds = await store.load();
          if (!creds) {
            failWith("Not logged in. Run `ib auth login` first.", 2);
          }
          // The bearer refresh re-derives DB claims and would DROP imp/imp_sid +
          // the 10-min cap — silently escalating an impersonation into a
          // permanent login as the target. Same invariant as the disabled
          // refresh-on-401 in cliContext.
          if (creds.impersonation) {
            failWith(
              "refresh is disabled while impersonating (it would escalate to a permanent login as the target)",
              4,
              "use `ib auth impersonate --extend` for 10 more minutes, or `--end` to restore your own login"
            );
          }
          // Bearer refresh first; OAuth refresh_token grant fallback when the
          // JWT already lapsed (fb#258). Persists JWT + rotated refresh token.
          await refreshAndPersistSession({
            endpoint: creds.endpoint,
            store,
            currentJwt: creds.jwt,
          });
          writeJson({ ok: true });
        } catch (e) {
          // The guards above already carry their own exit codes; anything else
          // that fails a refresh is an auth failure (exit 2). Re-raised so
          // `guarded` reports it — see `auth login`.
          if (e instanceof CliError) throw e;
          failWith(errorMessage(e), 2);
        }
      })
    );

  auth
    .command("impersonate")
    .argument("[personId]", "Target personId (or use --email)", (v: string) => parseId(v, "personId"))
    .option("--email <email>")
    .option("--end")
    .option("--extend")
    .action(guarded(async (
      personId: number | undefined,
      opts: { email?: string; end?: boolean; extend?: boolean },
    ) => {
      const store = createStore(defaultCredentialsPath());

      // --- end: restore the stashed admin login ---
      if (opts.end) {
        const current = await store.load();
        const admin = await store.load(IMPERSONATOR_PROFILE);
        if (!admin) {
          failWith("No active impersonation session to end.", 4);
        }
        // Best-effort audit end (non-fatal).
        try {
          const expired =
            !!current?.expiresAt && new Date(current.expiresAt).getTime() < Date.now();
          if (current && !expired) {
            await performImpersonateEnd({ endpoint: current.endpoint, jwt: current.jwt });
          } else if (current?.impersonation) {
            await performImpersonateEnd({
              endpoint: admin.endpoint,
              jwt: admin.jwt,
              sessionId: current.impersonation.sessionId,
              targetPersonId: current.personId,
            });
          }
        } catch {
          // Audit end is best-effort — restoring the admin session must proceed.
        }
        await store.save(admin, "default");
        await store.remove(IMPERSONATOR_PROFILE);
        writeJson({ ok: true, restored: { personId: admin.personId } });
        return;
      }

      // --- extend: renew the active session ---
      if (opts.extend) {
        assertPersistedSwitchAllowed(isReadOnly()); // persists a rotated JWT
        const current = await store.load();
        if (!current?.impersonation) {
          failWith("No active impersonation session to extend.", 4);
        }
        const { token } = await performImpersonateExtend({
          endpoint: current.endpoint,
          jwt: current.jwt,
        });
        const decoded = decodeJwtPayload(token);
        await store.save(
          buildImpersonationProfile(token, current.endpoint, decoded, new Date().toISOString()),
          "default",
        );
        writeJson({
          ok: true,
          expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        });
        return;
      }

      // --- start: mint + stash admin + persist imp session ---
      assertPersistedSwitchAllowed(isReadOnly()); // persists a rotated JWT
      if (personId === undefined && !opts.email) {
        failWith("Provide a target personId or --email.", 4);
      }
      const admin = await store.load();
      if (!admin) {
        failWith("Not logged in. Run `ib auth login` first.", 2);
      }
      if (admin.impersonation) {
        failWith("Already impersonating. Run `ib auth impersonate --end` first.", 4);
      }
      // Honor the global --endpoint (like `auth login`) so impersonation can be
      // minted against a specific backend (e.g. staging) instead of always the
      // stored credential endpoint. The stashed admin login keeps its OWN
      // endpoint, so `--end` restores cleanly. Absent --endpoint → prior behavior.
      const impEndpoint = getGlobalOptions(parent).endpoint ?? admin.endpoint;
      const { token } = await performImpersonate({
        endpoint: impEndpoint,
        jwt: admin.jwt,
        personId,
        email: opts.email,
      });
      const decoded = decodeJwtPayload(token);
      await store.save(admin, IMPERSONATOR_PROFILE); // stash the admin login
      await store.save(
        buildImpersonationProfile(token, impEndpoint, decoded, new Date().toISOString()),
        "default",
      );
      writeJson({
        ok: true,
        impersonating: {
          personId: decoded.personId,
          actorPersonId: decoded.imp,
          expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        },
      });
    }));
}
