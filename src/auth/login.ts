import { generatePkcePair, generateState } from "./pkce.js";
import { startCallbackServer } from "./callbackServer.js";
import { createStore } from "./store.js";
import { decodeJwtPayload } from "./jwt.js";

export interface LoginOptions {
  endpoint: string;
  credentialsPath: string;
  clientId?: string;
  timeoutMs?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

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
export async function performLogin(opts: LoginOptions): Promise<void> {
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

  // 3. Launch browser.
  const { default: open } = await import("open");
  await open(authorizeUrl.toString());

  // 4. Wait for callback then tear down listener regardless of outcome.
  let codeResult;
  try {
    codeResult = await server.waitForCode();
  } finally {
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
  const tokenBody = (await tokenRes.json()) as TokenResponse;

  // 6. Decode JWT for identity claims.
  const payload = decodeJwtPayload(tokenBody.access_token);
  if (payload.personId === undefined || payload.ownerAsiakasId === undefined) {
    throw new Error(
      "Login token is missing personId/ownerAsiakasId claims — cannot persist credentials"
    );
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
