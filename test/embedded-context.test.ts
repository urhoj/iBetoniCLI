import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runArgv } from "../src/runArgv.js";
import { createStore } from "../src/auth/store.js";

/**
 * Embedded (in-process `/api/cli/exec`) invocations must act with the CALLER's
 * identity, not the host process's. These cover the three factories that used
 * to resolve through the host's credentials because only `getClient` consulted
 * the embedded context: `getEndpoint` (version/doctor probes),
 * `getClientForAsiakas` (per-company fan-out) and `isReadOnly` (the write-lock
 * on paths that mutate outside the API client).
 */

const EMB_ENDPOINT = "https://embedded-caller.example.test";
const HOST_ENDPOINT = "https://host-credentials.example.invalid";

/** A decodable JWT (`header.payload.sig`) carrying the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `h.${body}.s`;
}

/** The caller's token, acting as a company that is NOT the fan-out target. */
const EMB_JWT = jwt({ personId: 42, ownerAsiakasId: 1349 });
const SWITCHED_JWT = "switched-ephemeral-jwt";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let home: string;
let credentialsPath: string;
let priorEnv: Record<string, string | undefined>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ib-emb-"));
  credentialsPath = join(home, ".ibetoni", "credentials.json");
  priorEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    IB_TOKEN: process.env.IB_TOKEN,
  };
  // Point the credential store at a throwaway HOME and make sure the developer's
  // own IB_TOKEN can't stand in for the host identity under test.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.IB_TOKEN;
  // A host session that the embedded path must never reach for: different token,
  // different endpoint, and refreshable (so a refresh would rewrite this file).
  await createStore(credentialsPath).save({
    jwt: "host-jwt",
    refreshToken: "host-refresh",
    issuedAt: "",
    expiresAt: "",
    personId: 10,
    ownerAsiakasId: 999,
    ownerAsiakasName: "Host Oy",
    endpoint: HOST_ENDPOINT,
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("embedded invocation context", () => {
  test("getEndpoint resolves the embedded endpoint, not the host session's", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ app: "puminet5api", version: "1.2.3", commit: "abc1234" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await runArgv(["version"], { token: EMB_JWT, endpoint: EMB_ENDPOINT });

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).endpoint).toBe(EMB_ENDPOINT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${EMB_ENDPOINT}/api/version`);
  });

  test("isReadOnly reflects EmbeddedCtx.readOnly", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    // `doctor` echoes `isReadOnly()` straight into its report, so it observes the
    // embedded write-lock wiring without mutating anything. (The argv carries no
    // `--read-only`, so only the embedded context can set it.)
    const r = await runArgv(["doctor"], {
      token: EMB_JWT,
      endpoint: EMB_ENDPOINT,
      readOnly: true,
    });

    expect(JSON.parse(r.stdout).readOnly).toBe(true);
  });

  // feedback #316: `company switch` persists a rotated JWT OUTSIDE the API
  // client, straight into the credentials file — which, embedded, is the HOST
  // SERVER's. Refused unconditionally, so a non-read-only remote caller cannot
  // rotate the server's own session.
  test("company switch is refused under an embedded context and leaves the host credentials untouched", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const before = readFileSync(credentialsPath, "utf8");

    const r = await runArgv(["company", "switch", "--to", "7"], {
      token: EMB_JWT,
      endpoint: EMB_ENDPOINT,
      readOnly: false, // NOT read-only — the embedded guard must still refuse
    });

    expect(r.exitCode).toBe(3);
    const env = JSON.parse(r.stderr.trim());
    expect(env.code).toBe("EMBEDDED_BLOCKED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credentialsPath, "utf8")).toBe(before);
  });

  test("the per-company client is derived from the embedded token and persists nothing", async () => {
    const seen: Array<{ url: string; method: string; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: u, method: init?.method ?? "GET", auth: headers.Authorization });
      // Server-side --my-companies route absent → client-side fan-out fallback.
      if (u.includes("/api/cli/person/search")) return jsonResponse({ error: "not found" }, 404);
      if (u.includes("/api/company-selection/available")) {
        return jsonResponse({
          companies: [{ asiakasId: 7, asiakasNimi: "Seiska Oy" }],
          currentCompanyId: 1349,
        });
      }
      if (u.includes("/api/company-selection/switch")) {
        return jsonResponse({
          token: SWITCHED_JWT,
          ownerAsiakasId: 7,
          ownerAsiakasName: "Seiska Oy",
        });
      }
      if (u.includes("/api/person/search")) return jsonResponse([{ personId: 9, etunimi: "Kalle" }]);
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const credentialsBefore = readFileSync(credentialsPath, "utf8");

    const r = await runArgv(["person", "search", "kalle", "--my-companies"], {
      token: EMB_JWT,
      endpoint: EMB_ENDPOINT,
    });

    stderrSpy.mockRestore();
    expect(r.exitCode).toBe(0);
    // The ephemeral company switch is minted FROM the caller's JWT …
    const switchCall = seen.find((c) => c.url.includes("/company-selection/switch"));
    expect(switchCall?.auth).toBe(`Bearer ${EMB_JWT}`);
    // … and the per-company search runs with the switched token it returned.
    const searchCall = seen.find((c) => c.url.endsWith("/api/person/search"));
    expect(searchCall?.auth).toBe(`Bearer ${SWITCHED_JWT}`);
    // Nothing anywhere in the fan-out touched the host session or its endpoint.
    expect(seen.every((c) => c.url.startsWith(EMB_ENDPOINT))).toBe(true);
    expect(seen.some((c) => c.auth === "Bearer host-jwt")).toBe(false);
    // The host's credentials file is neither rotated nor rewritten, and no
    // diagnostic leaks to the host's (uncaptured) stderr.
    expect(readFileSync(credentialsPath, "utf8")).toBe(credentialsBefore);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
