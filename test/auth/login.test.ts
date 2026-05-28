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

    // Our stubbed fetch only handles the token exchange. The simulated browser
    // callback uses node:http directly to bypass the stub and exercise the
    // real callback listener.
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
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
});
