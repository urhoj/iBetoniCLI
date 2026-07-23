import { generatePkcePair, generateState } from "./pkce.js";
import { startCallbackServer } from "./callbackServer.js";
import { createStore } from "./store.js";
import { decodeJwtPayload } from "./jwt.js";
/**
 * Drive the full OAuth 2.1 + PKCE authorization-code flow for `ib auth login`.
 *
 * Steps:
 *   1. Generate PKCE verifier/challenge + CSRF state.
 *   2. Start a 127.0.0.1 callback listener on a random port.
 *   3. Build `/oauth/authorize` URL and open it in the user's browser.
 *   4. Await the callback with `code` + `state` (state checked inside the server).
 *   5. POST `/oauth/token` to exchange the code for an access token.
 *   6. Decode the JWT to extract personId / ownerAsiakasId / email / tenant name.
 *   7. Persist the credentials profile to disk.
 *   8. Print a Finnish-style confirmation to stderr (stdout stays parseable).
 */
export async function performLogin(opts) {
    const clientId = opts.clientId ?? "ib-cli";
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const { verifier, challenge, method } = generatePkcePair();
    const state = generateState();
    // 1. Spin up local listener (binds 127.0.0.1, random port).
    const server = await startCallbackServer({ timeoutMs, expectedState: state });
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    // 2. Build authorize URL.
    const authorizeUrl = new URL(`${opts.endpoint}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", method);
    authorizeUrl.searchParams.set("state", state);
    // 3. Print the URL FIRST (fb#243): in a headless/no-browser environment
    // `open` fails or silently does nothing, and without this line the command
    // hangs with zero feedback. stderr only — stdout stays parseable.
    process.stderr.write(`Authorize in the browser:\n  ${authorizeUrl.toString()}\n`);
    // 3b. Preflight the authorize URL (fb#274): a 400/500 here (missing OAuth
    // client registration after a Redis wipe — fb#271 — or Redis down) would
    // otherwise only render in the browser tab while the CLI waits the full
    // callback timeout in silence. GET is side-effect-free server-side
    // (validate → 302 to the login page; no auth state stored, no rate limit).
    // A preflight TIMEOUT fails open — a slow cold-start must not block a login
    // the browser flow could still complete.
    let probe;
    try {
        probe = await fetch(authorizeUrl.toString(), {
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
        });
    }
    catch (e) {
        const name = typeof e === "object" && e !== null ? e.name : undefined;
        if (name === "TimeoutError") {
            process.stderr.write("Authorize preflight timed out after 10s — proceeding with the browser flow anyway.\n");
        }
        else {
            server.close();
            const msg = e instanceof Error ? e.message : String(e);
            const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
            throw new Error(`Cannot reach ${opts.endpoint} (${msg}${cause}) — login cannot succeed from this machine, so the browser was not opened. Check the endpoint/network, or set IB_TOKEN=<jwt> instead.`);
        }
    }
    if (probe && probe.status >= 400) {
        server.close();
        const body = await probe.text().catch(() => "");
        // Error pages are buildErrorHtml HTML with the message in <p>…</p>.
        const detail = /<p>([^<]*)<\/p>/.exec(body)?.[1] ??
            body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        throw new Error(`Authorize preflight failed: HTTP ${probe.status}${detail ? ` — ${detail}` : ""}. The server rejected the authorize URL, so the browser was not opened (no point waiting for a callback).`);
    }
    // 3c. Launch browser.
    process.stderr.write(`Waiting for the OAuth callback on 127.0.0.1:${server.port} (timeout ${Math.round(timeoutMs / 60_000)} min)…\n` +
        `Headless/no-browser environment? The callback must land on THIS machine, so copy-pasting the URL elsewhere won't finish the flow — set IB_TOKEN=<jwt> instead and skip \`ib auth login\` entirely.\n`);
    try {
        const { default: open } = await import("open");
        await open(authorizeUrl.toString());
    }
    catch {
        process.stderr.write("Could not launch a browser — open the URL above manually on this machine, or use IB_TOKEN.\n");
    }
    // 4. Wait for callback then tear down listener regardless of outcome.
    let codeResult;
    try {
        codeResult = await server.waitForCode();
    }
    finally {
        server.close();
    }
    // 5. Exchange auth code for tokens.
    const tokenRes = await fetch(`${opts.endpoint}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "authorization_code",
            code: codeResult.code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: redirectUri,
        }),
    });
    if (!tokenRes.ok) {
        const detail = await tokenRes.text().catch(() => "");
        throw new Error(`Token exchange failed: HTTP ${tokenRes.status} ${detail}`);
    }
    const tokenBody = (await tokenRes.json());
    // 6. Decode JWT for identity claims.
    const payload = decodeJwtPayload(tokenBody.access_token);
    if (payload.personId === undefined || payload.ownerAsiakasId === undefined) {
        throw new Error("Login token is missing personId/ownerAsiakasId claims — cannot persist credentials");
    }
    // 7. Persist credentials.
    const store = createStore(opts.credentialsPath);
    const now = new Date();
    await store.save({
        jwt: tokenBody.access_token,
        refreshToken: tokenBody.refresh_token ?? "",
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + tokenBody.expires_in * 1000).toISOString(),
        personId: payload.personId,
        ownerAsiakasId: payload.ownerAsiakasId,
        ownerAsiakasName: payload.ownerAsiakasName ?? "",
        endpoint: opts.endpoint,
    });
    // 8. Confirmation to stderr — stdout is reserved for JSON/parseable output.
    const who = payload.email ?? "user";
    const where = payload.ownerAsiakasName ?? `tenant ${payload.ownerAsiakasId}`;
    process.stderr.write(`Logged in as ${who} at ${where}.\n`);
}
//# sourceMappingURL=login.js.map