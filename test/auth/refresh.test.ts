import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  refreshToken,
  refreshViaOAuthGrant,
  refreshSession,
  refreshAndPersistSession,
} from "../../src/auth/refresh.js";
import type { CredentialsProfile, CredentialsStore } from "../../src/auth/store.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Minimal unsigned JWT with the given payload — the jwt.ts fallback decode path. */
function fakeJwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

/** In-memory CredentialsStore capturing every save for ordering assertions. */
function memoryStore(initial: CredentialsProfile | null) {
  const saves: CredentialsProfile[] = [];
  let current = initial;
  const store: CredentialsStore = {
    async load() {
      return current;
    },
    async save(creds) {
      saves.push(creds);
      current = creds;
    },
    async clear() {
      current = null;
    },
    async remove() {
      /* not used */
    },
  };
  return { store, saves, get: () => current };
}

function baseProfile(overrides: Partial<CredentialsProfile> = {}): CredentialsProfile {
  return {
    jwt: fakeJwt({ personId: 10, ownerAsiakasId: 8, exp: 1 }),
    refreshToken: "stored-refresh-token",
    issuedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-21T00:00:00.000Z",
    personId: 10,
    ownerAsiakasId: 8,
    ownerAsiakasName: "Kalle Urho Oy",
    endpoint: "https://api.example.com",
    ...overrides,
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const fail = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  mockFetch.mockReset();
});

describe("refreshToken", () => {
  test("200 response returns the new JWT and POSTs with Bearer header", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ token: "eyJnew", message: "Token refreshed successfully" })
    );
    const newJwt = await refreshToken({
      endpoint: "https://api.example.com",
      currentJwt: "eyJold",
    });
    expect(newJwt).toBe("eyJnew");
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/auth/refresh-token");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer eyJold");
  });

  test("non-200 response throws", async () => {
    mockFetch.mockResolvedValueOnce(fail(401, { error: "Could not refresh token" }));
    await expect(
      refreshToken({ endpoint: "https://api.example.com", currentJwt: "eyJold" })
    ).rejects.toThrow(/Refresh failed: HTTP 401/);
  });
});

describe("refreshViaOAuthGrant", () => {
  test("POSTs the refresh_token grant as public client ib-cli and returns both tokens", async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ access_token: "eyJfresh", token_type: "Bearer", refresh_token: "rotated-1" })
    );
    const result = await refreshViaOAuthGrant({
      endpoint: "https://api.example.com",
      refreshToken: "stored-refresh-token",
    });
    expect(result).toEqual({ jwt: "eyJfresh", refreshToken: "rotated-1" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/oauth/token");
    expect(JSON.parse(init.body)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "stored-refresh-token",
      client_id: "ib-cli",
    });
  });

  test("non-200 (invalid_grant) throws with detail", async () => {
    mockFetch.mockResolvedValueOnce(
      fail(400, { error: "invalid_grant", error_description: "Invalid or expired refresh token" })
    );
    await expect(
      refreshViaOAuthGrant({ endpoint: "https://api.example.com", refreshToken: "gone" })
    ).rejects.toThrow(/OAuth refresh-token grant failed: HTTP 400/);
  });

  test("missing access_token in a 200 body throws", async () => {
    mockFetch.mockResolvedValueOnce(ok({ token_type: "Bearer" }));
    await expect(
      refreshViaOAuthGrant({ endpoint: "https://api.example.com", refreshToken: "t" })
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("refreshSession", () => {
  test("bearer refresh succeeds — OAuth grant is never attempted", async () => {
    mockFetch.mockResolvedValueOnce(ok({ token: "eyJbearer" }));
    const result = await refreshSession({
      endpoint: "https://api.example.com",
      currentJwt: "eyJold",
      storedRefreshToken: "stored-refresh-token",
    });
    expect(result).toEqual({ jwt: "eyJbearer" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("bearer 401 falls back to the OAuth grant (the fb#258 dead-session case)", async () => {
    mockFetch
      .mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(ok({ access_token: "eyJhealed", refresh_token: "rotated-1" }));
    const result = await refreshSession({
      endpoint: "https://api.example.com",
      currentJwt: "eyJexpired",
      storedRefreshToken: "stored-refresh-token",
    });
    expect(result).toEqual({ jwt: "eyJhealed", refreshToken: "rotated-1" });
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.example.com/oauth/token");
  });

  test("bearer failure with NO stored refresh token rethrows the bearer error", async () => {
    mockFetch.mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }));
    await expect(
      refreshSession({ endpoint: "https://api.example.com", currentJwt: "eyJexpired" })
    ).rejects.toThrow(/Refresh failed: HTTP 401/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("both paths failing throws a combined, re-login-pointing error", async () => {
    mockFetch
      .mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(fail(400, { error: "invalid_grant" }));
    await expect(
      refreshSession({
        endpoint: "https://api.example.com",
        currentJwt: "eyJexpired",
        storedRefreshToken: "consumed",
      })
    ).rejects.toThrow(/Refresh failed: HTTP 401.*OAuth refresh-token grant failed: HTTP 400.*ib auth login/s);
  });
});

describe("refreshAndPersistSession", () => {
  test("OAuth-grant heal persists JWT + ROTATED refresh token + new expiresAt immediately", async () => {
    const freshExp = Math.floor(Date.now() / 1000) + 604800;
    const freshJwt = fakeJwt({ personId: 10, ownerAsiakasId: 8, exp: freshExp });
    mockFetch
      .mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(ok({ access_token: freshJwt, refresh_token: "rotated-1" }));
    const { store, saves } = memoryStore(baseProfile());

    const jwt = await refreshAndPersistSession({
      endpoint: "https://api.example.com",
      store,
      currentJwt: "eyJexpired",
    });

    expect(jwt).toBe(freshJwt);
    expect(saves).toHaveLength(1);
    expect(saves[0].jwt).toBe(freshJwt);
    expect(saves[0].refreshToken).toBe("rotated-1");
    expect(saves[0].expiresAt).toBe(new Date(freshExp * 1000).toISOString());
  });

  test("bearer-path refresh keeps the stored refresh token untouched", async () => {
    const freshExp = Math.floor(Date.now() / 1000) + 604800;
    const freshJwt = fakeJwt({ personId: 10, ownerAsiakasId: 8, exp: freshExp });
    mockFetch.mockResolvedValueOnce(ok({ token: freshJwt }));
    const { store, saves } = memoryStore(baseProfile());

    await refreshAndPersistSession({
      endpoint: "https://api.example.com",
      store,
      currentJwt: "eyJnear-expiry",
    });

    expect(saves).toHaveLength(1);
    expect(saves[0].refreshToken).toBe("stored-refresh-token");
  });

  test("sticky company: a grant JWT minted for the LOGIN-time company is switched back to the persisted active company", async () => {
    // Persisted active company is 62 (user switched after login); the grant
    // re-mints company 8 (login-time). Expect a switch back to 62.
    const grantJwt = fakeJwt({ personId: 10, ownerAsiakasId: 8, exp: 9999999999 });
    const switchedJwt = fakeJwt({ personId: 10, ownerAsiakasId: 62, exp: 9999999999 });
    mockFetch
      .mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(ok({ access_token: grantJwt, refresh_token: "rotated-1" }));
    const switchFn = vi.fn().mockResolvedValue({
      jwt: switchedJwt,
      ownerAsiakasId: 62,
      ownerAsiakasName: "Toinen Oy",
    });
    const { store, saves, get } = memoryStore(
      baseProfile({ ownerAsiakasId: 62, ownerAsiakasName: "Toinen Oy" })
    );

    const jwt = await refreshAndPersistSession({
      endpoint: "https://api.example.com",
      store,
      currentJwt: "eyJexpired",
      switchFn,
    });

    expect(switchFn).toHaveBeenCalledWith({
      endpoint: "https://api.example.com",
      jwt: grantJwt,
      toAsiakasId: 62,
    });
    expect(jwt).toBe(switchedJwt);
    // Two saves: rotation persisted FIRST (crash-safety before the switch
    // round-trip), then the switched JWT.
    expect(saves).toHaveLength(2);
    expect(saves[0].jwt).toBe(grantJwt);
    expect(saves[0].refreshToken).toBe("rotated-1");
    expect(get()?.jwt).toBe(switchedJwt);
    expect(get()?.ownerAsiakasId).toBe(62);
  });

  test("sticky-company switch failure keeps the fresh JWT and records the ACTUAL company", async () => {
    const grantJwt = fakeJwt({
      personId: 10,
      ownerAsiakasId: 8,
      ownerAsiakasName: "Kalle Urho Oy",
      exp: 9999999999,
    });
    mockFetch
      .mockResolvedValueOnce(fail(401, { error: "INVALID_TOKEN" }))
      .mockResolvedValueOnce(ok({ access_token: grantJwt, refresh_token: "rotated-1" }));
    const switchFn = vi.fn().mockRejectedValue(new Error("HTTP 403 no access"));
    const { store, get } = memoryStore(
      baseProfile({ ownerAsiakasId: 62, ownerAsiakasName: "Toinen Oy" })
    );

    const jwt = await refreshAndPersistSession({
      endpoint: "https://api.example.com",
      store,
      currentJwt: "eyJexpired",
      switchFn,
    });

    expect(jwt).toBe(grantJwt);
    expect(get()?.ownerAsiakasId).toBe(8);
    expect(get()?.ownerAsiakasName).toBe("Kalle Urho Oy");
  });

  test("no creds file: refreshes via bearer and returns without persisting", async () => {
    mockFetch.mockResolvedValueOnce(ok({ token: "eyJfresh" }));
    const { store, saves } = memoryStore(null);
    const jwt = await refreshAndPersistSession({
      endpoint: "https://api.example.com",
      store,
      currentJwt: "eyJold",
    });
    expect(jwt).toBe("eyJfresh");
    expect(saves).toHaveLength(0);
  });
});
