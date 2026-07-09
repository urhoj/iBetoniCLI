import { describe, test, expect, vi, afterEach } from "vitest";
import {
  performImpersonate, buildImpersonationProfile, IMPERSONATOR_PROFILE,
} from "../../src/auth/impersonate.js";
import type { DecodedClaims } from "../../src/auth/jwt.js";

afterEach(() => vi.restoreAllMocks());

describe("performImpersonate", () => {
  test("POSTs to /api/auth/impersonate with personId and returns the token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "IMP" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await performImpersonate({ endpoint: "https://x", jwt: "ADMIN", personId: 6233 });
    expect(r).toEqual({ token: "IMP" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://x/api/auth/impersonate");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ personId: 6233 });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer ADMIN" });
  });

  test("sends email when given instead of personId", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: "IMP" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await performImpersonate({ endpoint: "https://x", jwt: "ADMIN", email: "a@b.fi" });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ email: "a@b.fi" });
  });

  test("throws a CliError with exit 3 on 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "denied" }), { status: 403, headers: { "content-type": "application/json" } }),
    ));
    await expect(performImpersonate({ endpoint: "https://x", jwt: "A", personId: 1 }))
      .rejects.toMatchObject({ statusCode: 403, exitCode: 3 });
  });

  // feedback #113: the backend 404s identically whether the target is missing
  // or exists-but-email-less. On the personId path, clarify both cases + hint.
  test("clarifies the ambiguous 404 on the personId path (missing OR email-less)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("Kohdehenkilöä ei löytynyt", { status: 404 }),
    ));
    const err = await performImpersonate({ endpoint: "https://x", jwt: "A", personId: 6259 })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404, exitCode: 5 });
    expect(err.message).toContain("personEmail");
    expect(err.message).toContain("6259");
    expect(err.hint).toContain("ib person get 6259");
  });

  test("does NOT rewrite the 404 on the --email path (email simply not registered)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("Kohdehenkilöä ei löytynyt", { status: 404 }),
    ));
    const err = await performImpersonate({ endpoint: "https://x", jwt: "A", email: "nobody@x.fi" })
      .catch((e) => e);
    expect(err).toMatchObject({ statusCode: 404, exitCode: 5 });
    expect(err.message).not.toContain("personEmail");
    expect(err.hint).toBeUndefined();
  });
});

describe("buildImpersonationProfile", () => {
  test("maps decoded claims into a non-refreshable impersonation profile", () => {
    const decoded = {
      personId: 6233, ownerAsiakasId: 1349, ownerAsiakasName: "BetoniJerry",
      exp: 1000, imp: 10, imp_sid: "sid",
    } as DecodedClaims;
    const p = buildImpersonationProfile("IMP", "https://x", decoded, "2026-06-25T00:00:00.000Z");
    expect(p).toEqual({
      jwt: "IMP", refreshToken: "", issuedAt: "2026-06-25T00:00:00.000Z",
      expiresAt: new Date(1000 * 1000).toISOString(),
      personId: 6233, ownerAsiakasId: 1349, ownerAsiakasName: "BetoniJerry",
      endpoint: "https://x", impersonation: { actorPersonId: 10, sessionId: "sid" },
    });
  });
});

test("IMPERSONATOR_PROFILE is the reserved stash name", () => {
  expect(IMPERSONATOR_PROFILE).toBe("_impersonator");
});
