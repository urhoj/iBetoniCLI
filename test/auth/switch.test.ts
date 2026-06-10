import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  performSwitch,
  assertPersistedSwitchAllowed,
} from "../../src/auth/switch.js";
import { CliError } from "../../src/api/errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("performSwitch", () => {
  beforeEach(() => mockFetch.mockReset());

  test("POSTs { newAsiakasId } to /api/company-selection/switch and maps the body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "eyJnew",
          ownerAsiakasId: 26,
          ownerAsiakasName: "PumiNet Oy",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await performSwitch({
      endpoint: "https://api.example.com",
      jwt: "eyJbase",
      toAsiakasId: 26,
    });
    expect(result).toEqual({
      jwt: "eyJnew",
      ownerAsiakasId: 26,
      ownerAsiakasName: "PumiNet Oy",
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.example.com/api/company-selection/switch");
    expect(init.body).toBe(JSON.stringify({ newAsiakasId: 26 }));
    expect(init.headers["Authorization"]).toBe("Bearer eyJbase");
  });

  test("403 (no access) rejects with a CliError mapped to exit 3", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "no access" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
    );
    const err = await performSwitch({
      endpoint: "https://api.example.com",
      jwt: "eyJbase",
      toAsiakasId: 999,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).statusCode).toBe(403);
    expect((err as CliError).exitCode).toBe(3);
  });

  test("401 (expired) rejects with a CliError mapped to exit 2", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "token expired" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const err = await performSwitch({
      endpoint: "https://api.example.com",
      jwt: "expired",
      toAsiakasId: 26,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
  });
});

describe("assertPersistedSwitchAllowed (read-only write-lock)", () => {
  test("read-only mode refuses a persisted switch with a CliError mapped to exit 3", () => {
    let err: unknown;
    try {
      assertPersistedSwitchAllowed(true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect((err as CliError).message).toMatch(/read-only/i);
  });

  test("no-op when read-only mode is off", () => {
    expect(() => assertPersistedSwitchAllowed(false)).not.toThrow();
  });
});
