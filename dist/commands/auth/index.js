import { getGlobalOptions } from "../../globals.js";
import { createStore, defaultCredentialsPath } from "../../auth/store.js";
import { performLogin } from "../../auth/login.js";
import { performLogout } from "../../auth/logout.js";
import { renderWhoami } from "../../auth/whoami.js";
import { performSwitch, assertPersistedSwitchAllowed, } from "../../auth/switch.js";
import { refreshToken } from "../../auth/refresh.js";
import { decodeJwtPayload } from "../../auth/jwt.js";
import { resolveAuth } from "../../auth/resolve.js";
import { resolveCallerTier } from "../../tier.js";
import { performImpersonate, performImpersonateExtend, performImpersonateEnd, buildImpersonationProfile, IMPERSONATOR_PROFILE, } from "../../auth/impersonate.js";
import { writeJson, writeError, exitWithError, failWith, } from "../../output/json.js";
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
export function registerAuthCommands(parent, isReadOnly) {
    const auth = parent.command("auth").description("Authentication commands");
    auth
        .command("login")
        .description("Open browser to authorize this CLI and persist credentials")
        // No LOCAL --endpoint option: the root global `--endpoint` claims the value
        // during parse (Commander recognises root options anywhere), so a local
        // duplicate silently fell back to its default — `auth login --endpoint
        // <staging>` authorized against PROD. Read the global instead.
        .action(async () => {
        try {
            await performLogin({
                endpoint: getGlobalOptions(parent).endpoint ?? "https://api.ibetoni.fi",
                credentialsPath: defaultCredentialsPath(),
            });
        }
        catch (e) {
            // exitCode + return, NOT process.exit(): forced exit after the OAuth
            // fetches crashes Node on Windows (libuv assert → exit 127).
            writeError(e);
            process.exitCode = 2;
        }
    });
    auth
        .command("logout")
        .description("Revoke the refresh token and delete local credentials")
        .action(async () => {
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
        }
        catch (e) {
            // exitCode + return — see `auth login` (Windows libuv crash).
            writeError(e);
            process.exitCode = 1;
        }
    });
    auth
        .command("whoami")
        .description("Print the current authenticated user")
        .action(async () => {
        try {
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
            const claims = decodeJwtPayload(resolved.token);
            const tier = resolveCallerTier(resolved.token);
            // Impersonation marker lives on the creds profile (file sessions);
            // renderWhoami falls back to the JWT imp claims for IB_TOKEN sessions.
            const profile = resolved.source === "file"
                ? await createStore(defaultCredentialsPath()).load()
                : null;
            writeJson(renderWhoami({
                claims,
                endpoint: resolved.endpoint,
                source: resolved.source,
                readOnly: isReadOnly(),
                tier,
                impersonation: profile?.impersonation,
            }));
        }
        catch (e) {
            exitWithError(e);
        }
    });
    auth
        .command("switch")
        .description("Switch the active company")
        .requiredOption("--to <asiakasId>", "Target asiakasId", (v) => Number(v))
        .action(async (opts) => {
        try {
            assertPersistedSwitchAllowed(isReadOnly());
            const store = createStore(defaultCredentialsPath());
            const creds = await store.load();
            if (!creds) {
                failWith("Not logged in. Run `ib auth login` first.", 2);
            }
            const next = await performSwitch({
                endpoint: creds.endpoint,
                jwt: creds.jwt,
                toAsiakasId: opts.to,
            });
            await store.save({
                ...creds,
                jwt: next.jwt,
                ownerAsiakasId: next.ownerAsiakasId,
                ownerAsiakasName: next.ownerAsiakasName,
            });
            writeJson({
                ok: true,
                activeCompany: {
                    asiakasId: next.ownerAsiakasId,
                    name: next.ownerAsiakasName,
                },
            });
        }
        catch (e) {
            exitWithError(e);
        }
    });
    auth
        .command("refresh")
        .description("Refresh the JWT manually")
        .action(async () => {
        try {
            const store = createStore(defaultCredentialsPath());
            const creds = await store.load();
            if (!creds) {
                failWith("Not logged in. Run `ib auth login` first.", 2);
            }
            const fresh = await refreshToken({
                endpoint: creds.endpoint,
                currentJwt: creds.jwt,
            });
            await store.save({ ...creds, jwt: fresh });
            writeJson({ ok: true });
        }
        catch (e) {
            // exitCode + return — see `auth login` (Windows libuv crash).
            writeError(e);
            process.exitCode = 2;
        }
    });
    auth
        .command("impersonate")
        .description("Impersonate another person (server-gated by canImpersonate)")
        .argument("[personId]", "Target personId (or use --email)", (v) => Number(v))
        .option("--email <email>", "Target email (alternative to the personId positional)")
        .option("--end", "End the active impersonation session and restore your own login")
        .option("--extend", "Extend the active impersonation session by 10 minutes")
        .action(async (personId, opts) => {
        try {
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
                    const expired = !!current?.expiresAt && new Date(current.expiresAt).getTime() < Date.now();
                    if (current && !expired) {
                        await performImpersonateEnd({ endpoint: current.endpoint, jwt: current.jwt });
                    }
                    else if (current?.impersonation) {
                        await performImpersonateEnd({
                            endpoint: admin.endpoint,
                            jwt: admin.jwt,
                            sessionId: current.impersonation.sessionId,
                            targetPersonId: current.personId,
                        });
                    }
                }
                catch {
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
                await store.save(buildImpersonationProfile(token, current.endpoint, decoded, new Date().toISOString()), "default");
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
            await store.save(buildImpersonationProfile(token, impEndpoint, decoded, new Date().toISOString()), "default");
            writeJson({
                ok: true,
                impersonating: {
                    personId: decoded.personId,
                    actorPersonId: decoded.imp,
                    expiresAt: decoded.exp ? new Date(decoded.exp * 1000).toISOString() : null,
                },
            });
        }
        catch (e) {
            exitWithError(e);
        }
    });
}
//# sourceMappingURL=index.js.map