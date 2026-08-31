import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  performSwitch,
  assertPersistedSwitchAllowed,
  runPersistedSwitch,
} from "../../src/auth/switch.js";
import { notLoggedInMessage } from "../../src/auth/notLoggedIn.js";
import { CliError } from "../../src/api/errors.js";
import { runEmbedded, makeEmbeddedCtx, type EmbeddedCtx } from "../../src/embedded.js";

function embeddedCtx(readOnly = false): EmbeddedCtx {
  return makeEmbeddedCtx({
    token: "eyJembedded",
    endpoint: "https://api.example.test",
    tier: "developer",
    readOnly,
  });
}

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
    expect((err as CliError).body).toEqual({ code: "READ_ONLY_BLOCKED" });
  });

  test("no-op when read-only mode is off", () => {
    expect(() => assertPersistedSwitchAllowed(false)).not.toThrow();
  });
});

// feedback #316: an embedded/in-process invocation has no credentials file of
// its own — a persisted switch there would rotate the HOST server's session JWT
// on behalf of a remote caller. Refused regardless of the read-only flag.
describe("assertPersistedSwitchAllowed (embedded invocation)", () => {
  test("refuses under an embedded context even when NOT read-only", async () => {
    const err = await runEmbedded(embeddedCtx(false), async () => {
      try {
        assertPersistedSwitchAllowed(false);
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect((err as CliError).body).toEqual({ code: "EMBEDDED_BLOCKED" });
    expect((err as CliError).message).toMatch(/embedded\/remote invocation/i);
  });

  test("the embedded refusal wins over the read-only refusal", async () => {
    const err = await runEmbedded(embeddedCtx(true), async () => {
      try {
        assertPersistedSwitchAllowed(true);
        return null;
      } catch (e) {
        return e;
      }
    });
    expect((err as CliError).body).toEqual({ code: "EMBEDDED_BLOCKED" });
  });
});

// fb#1102: the literal in runPersistedSwitch's not-logged-in check was swapped
// for notLoggedInMessage() (one source of truth with whoami/refresh/impersonate)
// — behavior-neutral, since this switch is always endpoint-agnostic (no
// --endpoint override to name) and notLoggedInMessage() with no endpoint
// produces the identical text.
describe("runPersistedSwitch (not logged in)", () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-switch-"));
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("no stored session -> CliError exit 2 with the shared not-logged-in message", async () => {
    const err = await runPersistedSwitch(26, false).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as CliError).message).toBe(notLoggedInMessage());
  });
});
