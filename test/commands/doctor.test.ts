import { describe, test, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { runDoctor } from "../../src/commands/doctor/index.js";
import type { ApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/api/errors.js";

/** Build a decodable long-shape JWT (header.payload.sig) for the identity read. */
function makeJwt(payload: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256", typ: "JWT" })}.${b(payload)}.sig`;
}

const NOW = 1_750_000_000_000; // fixed "now" for deterministic expiry checks
const FUTURE_EXP = Math.floor(NOW / 1000) + 3600;
const PAST_EXP = Math.floor(NOW / 1000) - 3600;

function claims(exp: number) {
  return {
    personId: 10,
    ownerAsiakasId: 8,
    ownerAsiakasName: "Kalle Urho Oy",
    email: "a@b.fi",
    issuedFor: "cli",
    exp,
  };
}

function mockClient(token: string, getImpl: () => Promise<unknown>): ApiClient {
  return {
    get: vi.fn(getImpl),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getCurrentToken: () => token,
  } as unknown as ApiClient;
}

function reachableFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ app: "puminet5api", version: "1.0", commit: "abc", slot: "production" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  ) as unknown as typeof fetch;
}

describe("runDoctor", () => {
  test("healthy: reachable + probe ok + token valid → ok true", async () => {
    const client = mockClient(makeJwt(claims(FUTURE_EXP)), async () => ({
      companies: [{ asiakasId: 8, asiakasNimi: "Kalle Urho Oy" }],
      currentCompanyId: 8,
    }));
    const report = await runDoctor({
      client,
      endpoint: "https://api.example.com",
      cliVersion: "1.2.3",
      readOnly: false,
      nowMs: NOW,
      fetchImpl: reachableFetch(),
    });
    expect(report.ok).toBe(true);
    expect(report.auth).toMatchObject({
      personId: 10,
      ownerAsiakasId: 8,
      ownerAsiakasName: "Kalle Urho Oy",
      issuedFor: "cli",
      tokenExpired: false,
    });
    expect(report.connectivity.reachable).toBe(true);
    expect(report.authProbe).toEqual({ ok: true });
  });

  test("surfaces tier (from globalRoles) and switchable companies (from asiakasesWithTypes)", async () => {
    const payload = {
      ...claims(FUTURE_EXP),
      globalRoles: { isDeveloper: true },
      asiakasesWithTypes: [
        { asiakasId: 8, roles: ["asiakasAdmin"] },
        { asiakasId: 26, roles: [] },
      ],
    };
    const client = mockClient(makeJwt(payload), async () => ({ companies: [], currentCompanyId: 8 }));
    const report = await runDoctor({
      client,
      endpoint: "https://api.example.com",
      cliVersion: "1.2.3",
      readOnly: false,
      nowMs: NOW,
      fetchImpl: reachableFetch(),
    });
    expect(report.auth.tier).toBe("developer");
    expect(report.auth.companies).toEqual([
      { asiakasId: 8, roles: ["asiakasAdmin"] },
      { asiakasId: 26, roles: [] },
    ]);
    // A normal token carries no imp claim → impersonating omitted.
    expect(report.auth.impersonating).toBeUndefined();
  });

  test("surfaces an active impersonation session (imp/imp_sid claims)", async () => {
    const payload = { ...claims(FUTURE_EXP), imp: 999, imp_sid: "sess-xyz" };
    const client = mockClient(makeJwt(payload), async () => ({ companies: [], currentCompanyId: 8 }));
    const report = await runDoctor({
      client,
      endpoint: "https://api.example.com",
      cliVersion: "1.2.3",
      readOnly: false,
      nowMs: NOW,
      fetchImpl: reachableFetch(),
    });
    expect(report.auth.impersonating).toEqual({ actorPersonId: 999, sessionId: "sess-xyz" });
  });

  test("unreachable endpoint → ok false", async () => {
    const client = mockClient(makeJwt(claims(FUTURE_EXP)), async () => ({
      companies: [],
      currentCompanyId: 8,
    }));
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const report = await runDoctor({
      client,
      endpoint: "https://down.example.com",
      cliVersion: "1.2.3",
      readOnly: false,
      nowMs: NOW,
      fetchImpl: failing,
    });
    expect(report.connectivity.reachable).toBe(false);
    expect(report.ok).toBe(false);
  });

  test("auth probe 401 → authProbe.ok false, ok false", async () => {
    const client = mockClient(makeJwt(claims(FUTURE_EXP)), async () => {
      throw new CliError("Token expired", 401, null, 2);
    });
    const report = await runDoctor({
      client,
      endpoint: "https://api.example.com",
      cliVersion: "1.2.3",
      readOnly: true,
      nowMs: NOW,
      fetchImpl: reachableFetch(),
    });
    expect(report.authProbe).toMatchObject({ ok: false, status: 401 });
    expect(report.readOnly).toBe(true);
    expect(report.ok).toBe(false);
  });

  test("expired token → tokenExpired true, ok false", async () => {
    const client = mockClient(makeJwt(claims(PAST_EXP)), async () => ({
      companies: [],
      currentCompanyId: 8,
    }));
    const report = await runDoctor({
      client,
      endpoint: "https://api.example.com",
      cliVersion: "1.2.3",
      readOnly: false,
      nowMs: NOW,
      fetchImpl: reachableFetch(),
    });
    expect(report.auth.tokenExpired).toBe(true);
    expect(report.ok).toBe(false);
  });
});
