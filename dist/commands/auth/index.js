import { createStore, defaultCredentialsPath } from "../../auth/store.js";
import { performLogin } from "../../auth/login.js";
import { performLogout } from "../../auth/logout.js";
import { renderWhoami } from "../../auth/whoami.js";
import { performSwitch } from "../../auth/switch.js";
import { refreshToken } from "../../auth/refresh.js";
import { writeJson, writeError } from "../../output/json.js";
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
 */
export function registerAuthCommands(parent) {
    const auth = parent.command("auth").description("Authentication commands");
    auth
        .command("login")
        .description("Open browser to authorize this CLI and persist credentials")
        .option("--endpoint <url>", "API endpoint", "https://api.ibetoni.fi")
        .action(async (opts) => {
        try {
            await performLogin({
                endpoint: opts.endpoint,
                credentialsPath: defaultCredentialsPath(),
            });
        }
        catch (e) {
            writeError(e);
            process.exit(2);
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
            writeError(e);
            process.exit(1);
        }
    });
    auth
        .command("whoami")
        .description("Print the current authenticated user")
        .action(async () => {
        try {
            const creds = await createStore(defaultCredentialsPath()).load();
            if (!creds) {
                writeError(new Error("Not logged in. Run `ib auth login` first."));
                process.exit(2);
            }
            writeJson(renderWhoami(creds));
        }
        catch (e) {
            writeError(e);
            process.exit(1);
        }
    });
    auth
        .command("switch")
        .description("Switch the active company")
        .requiredOption("--to <asiakasId>", "Target asiakasId", (v) => Number(v))
        .action(async (opts) => {
        try {
            const store = createStore(defaultCredentialsPath());
            const creds = await store.load();
            if (!creds) {
                writeError(new Error("Not logged in. Run `ib auth login` first."));
                process.exit(2);
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
            writeError(e);
            process.exit(1);
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
                writeError(new Error("Not logged in. Run `ib auth login` first."));
                process.exit(2);
            }
            const fresh = await refreshToken({
                endpoint: creds.endpoint,
                currentJwt: creds.jwt,
            });
            await store.save({ ...creds, jwt: fresh });
            writeJson({ ok: true });
        }
        catch (e) {
            writeError(e);
            process.exit(2);
        }
    });
}
//# sourceMappingURL=index.js.map