import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { performLogin } from "../../src/auth/login.js";

// vi.mock is hoisted to the top, so the factory cannot close over file-scope
// variables. Use vi.hoisted to lift our fn alongside it.
const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));
vi.mock("open", () => ({ default: mockOpen }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Build a syntactically valid JWT (header.payload.sig) with a payload our
// raw base64url fallback can decode. We don't sign anything — `decodeJwtPayload`
// only reads the payload segment.
function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("performLogin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-login-"));
    mockOpen.mockReset();
    mockFetch.mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("opens browser, completes token exchange, persists credentials", async () => {
    const fakeJwt = buildFakeJwt({
      personId: 42,
      ownerAsiakasId: 1349,
      ownerAsiakasName: "Test Oy",
      email: "test@example.com",
    });

    // Our stubbed fetch handles the authorize preflight (fb#274) and the token
    // exchange. The simulated browser callback uses node:http directly to
    // bypass the stub and exercise the real callback listener.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/oauth/authorize")) {
        // Server-side success: 302 redirect to the frontend login page.
        return new Response(null, { status: 302 });
      }
      if (urlStr.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: fakeJwt,
            refresh_token: "rt_test",
            expires_in: 604800,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch in mock: ${urlStr}`);
    });

    mockOpen.mockImplementation((authorizeUrl: string) => {
      const url = new URL(authorizeUrl);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const port = redirectUri.match(/:(\d+)/)?.[1];
      const state = url.searchParams.get("state") ?? "";
      setTimeout(() => {
        void import("node:http").then((http) => {
          http
            .get(`http://127.0.0.1:${port}/callback?code=test_auth_code&state=${state}`)
            .on("error", () => {
              /* ignore */
            });
        });
      }, 30);
      return Promise.resolve({} as never);
    });

    const credentialsPath = join(dir, "credentials.json");
    await performLogin({
      endpoint: "https://api.example.com",
      credentialsPath,
      timeoutMs: 5000,
    });

    // Verify the browser was launched with a valid authorize URL.
    expect(mockOpen).toHaveBeenCalledTimes(1);
    const authorizeUrl = new URL(mockOpen.mock.calls[0][0] as string);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://api.example.com/oauth/authorize"
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("ib-cli");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/
    );

    // Verify the preflight probe (fb#274): same authorize URL, manual redirect.
    const probeCalls = mockFetch.mock.calls.filter((c) =>
      c[0].toString().includes("/oauth/authorize")
    );
    expect(probeCalls).toHaveLength(1);
    expect(probeCalls[0][0].toString()).toBe(authorizeUrl.toString());
    expect((probeCalls[0][1] as RequestInit).redirect).toBe("manual");

    // Verify the token exchange call.
    const tokenCalls = mockFetch.mock.calls.filter((c) =>
      c[0].toString().endsWith("/oauth/token")
    );
    expect(tokenCalls).toHaveLength(1);
    const [, tokenInit] = tokenCalls[0] as [string, RequestInit];
    expect(tokenInit.method).toBe("POST");
    const body = JSON.parse(tokenInit.body as string) as Record<string, unknown>;
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("test_auth_code");
    expect(body.client_id).toBe("ib-cli");
    expect(body.code_verifier).toBeTruthy();
    expect(body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // Verify credentials were persisted with decoded claims.
    const { createStore } = await import("../../src/auth/store.js");
    const store = createStore(credentialsPath);
    const creds = await store.load();
    expect(creds?.jwt).toBe(fakeJwt);
    expect(creds?.refreshToken).toBe("rt_test");
    expect(creds?.personId).toBe(42);
    expect(creds?.ownerAsiakasId).toBe(1349);
    expect(creds?.ownerAsiakasName).toBe("Test Oy");
    expect(creds?.endpoint).toBe("https://api.example.com");
  });

  test("fails fast when the authorize preflight returns 4xx (fb#274)", async () => {
    // fb#271 scenario: OAuth client registration missing → 400 error page that
    // previously only rendered in the browser while the CLI hung for 5 min.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/oauth/authorize")) {
        return new Response(
          '<!DOCTYPE html><html><body><div class="error"><h2>Error</h2>' +
            "<p>Unknown client_id or invalid redirect_uri</p></div></body></html>",
          { status: 400, headers: { "content-type": "text/html" } }
        );
      }
      throw new Error(`Unexpected fetch in mock: ${urlStr}`);
    });

    await expect(
      performLogin({
        endpoint: "https://api.example.com",
        credentialsPath: join(dir, "credentials.json"),
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/HTTP 400.*Unknown client_id or invalid redirect_uri/);
    // The browser must never open on a failed preflight.
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test("fails fast when the endpoint is unreachable (fb#274)", async () => {
    mockFetch.mockImplementation(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED 127.0.0.1:443"),
      });
    });

    await expect(
      performLogin({
        endpoint: "https://api.example.com",
        credentialsPath: join(dir, "credentials.json"),
        timeoutMs: 5000,
      })
    ).rejects.toThrow(/Cannot reach https:\/\/api\.example\.com.*ECONNREFUSED/);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test("proceeds with the browser flow when the preflight times out (fb#274)", async () => {
    // A slow cold-start must not block a login the browser could complete:
    // TimeoutError → warn + fail-open.
    const fakeJwt = buildFakeJwt({ personId: 42, ownerAsiakasId: 1349 });
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes("/oauth/authorize")) {
        throw Object.assign(new Error("The operation timed out"), {
          name: "TimeoutError",
        });
      }
      if (urlStr.endsWith("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: fakeJwt, expires_in: 604800 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch in mock: ${urlStr}`);
    });
    mockOpen.mockImplementation((authorizeUrl: string) => {
      const url = new URL(authorizeUrl);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const port = redirectUri.match(/:(\d+)/)?.[1];
      const state = url.searchParams.get("state") ?? "";
      setTimeout(() => {
        void import("node:http").then((http) => {
          http
            .get(`http://127.0.0.1:${port}/callback?code=test_auth_code&state=${state}`)
            .on("error", () => {
              /* ignore */
            });
        });
      }, 30);
      return Promise.resolve({} as never);
    });

    await performLogin({
      endpoint: "https://api.example.com",
      credentialsPath: join(dir, "credentials.json"),
      timeoutMs: 5000,
    });
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});
