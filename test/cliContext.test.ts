import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliContext } from "../src/cliContext.js";
import { createStore } from "../src/auth/store.js";
import { CliError, hintForError } from "../src/api/errors.js";
import { performSwitch } from "../src/auth/switch.js";
import type { GlobalOptions } from "../src/globals.js";

vi.mock("../src/auth/switch.js", () => ({ performSwitch: vi.fn() }));

const EMPTY_GLOBAL: GlobalOptions = {
  endpoint: null,
  requestId: null,
  quiet: false,
  verbose: false,
  pretty: false,
  json: false,
  readOnly: false,
  asiakas: null,
  stats: false,
  columns: null,
  printPayload: false,
};

describe("createCliContext", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-ctx-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null client when no auth resolved", async () => {
    const ctx = await createCliContext({
      credentialsPath: join(dir, "missing.json"),
      version: "1.0.0",
      global: EMPTY_GLOBAL,
    });
    expect(ctx.client).toBeNull();
    expect(ctx.endpoint).toBe("https://api.ibetoni.fi");
    expect(ctx.personId).toBeNull();
    expect(ctx.ownerAsiakasId).toBeNull();
  });

  test("returns a configured client and endpoint when credentials exist", async () => {
    const file = join(dir, "credentials.json");
    await createStore(file).save({
      jwt: "j",
      refreshToken: "r",
      issuedAt: "",
      expiresAt: "",
      personId: 42,
      ownerAsiakasId: 1349,
      ownerAsiakasName: "Test Oy",
      endpoint: "https://api.example.com",
    });

    const ctx = await createCliContext({
      credentialsPath: file,
      version: "1.0.0",
      global: EMPTY_GLOBAL,
    });

    expect(ctx.client).not.toBeNull();
    expect(ctx.endpoint).toBe("https://api.example.com");
    expect(ctx.personId).toBe(42);
    expect(ctx.ownerAsiakasId).toBe(1349);
  });
});

// feedback #311: a --company switch 403 must NOT inherit the running command's
// own 403 remedy — the switch fails before that command's endpoint is ever
// called, so e.g. "check auth.page.person.read" is a false lead.
describe("createCliContext — --company switch 403 (feedback #311)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-ctx-403-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(performSwitch).mockReset();
  });

  async function switchTo(targetAsiakasId: number): Promise<CliError> {
    const file = join(dir, "credentials.json");
    await createStore(file).save({
      jwt: "j",
      refreshToken: "r",
      issuedAt: "",
      expiresAt: "",
      personId: 42,
      ownerAsiakasId: 8,
      ownerAsiakasName: "Kalle Urho Oy",
      endpoint: "https://api.example.com",
    });
    try {
      await createCliContext({
        credentialsPath: file,
        version: "1.0.0",
        global: { ...EMPTY_GLOBAL, asiakas: targetAsiakasId },
      });
    } catch (e) {
      return e as CliError;
    }
    throw new Error("createCliContext did not throw");
  }

  test("carries an empty hint so the leaf spec's 403 remedy is suppressed", async () => {
    vi.mocked(performSwitch).mockRejectedValue(
      new CliError("Company switch failed: HTTP 403 no access", 403, null, 3)
    );

    const err = await switchTo(1349);

    expect(err.statusCode).toBe(403);
    expect(err.exitCode).toBe(3);
    expect(err.message).toMatch(/MEMBER of/);
    expect(err.message).toMatch(/--asiakas <id>/);
    expect(err.hint).toBe("");
    expect(
      hintForError(err, [
        { http: 403, exit: 3, meaning: "Permission denied", remedy: "check auth.page.person.read" },
      ])
    ).toBeNull();
  });

  test("a non-403 switch failure propagates untouched (no note, no suppression)", async () => {
    vi.mocked(performSwitch).mockRejectedValue(
      new CliError("Company switch failed: HTTP 500 boom", 500, null, 6)
    );

    const err = await switchTo(1349);

    expect(err.statusCode).toBe(500);
    expect(err.message).not.toMatch(/MEMBER of/);
    expect(err.hint).toBeUndefined();
  });
});

// fb#855: sessions are per endpoint. A file session's token is endpoint-specific,
// so under `--endpoint <other>` the context must resolve ONLY a session minted
// for that endpoint — never present the active session's token there (a 401
// with a misleading remedy, fb#465/fb#484), never refresh against it, never
// persist anything. No session for it = not logged in there, before any request.
describe("createCliContext — --endpoint selects the session minted for it (fb#855)", () => {
  let dir: string;
  const mockFetch = vi.fn();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ib-ctx-855-"));
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(performSwitch).mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const session = (endpoint: string, jwt: string) => ({
    jwt,
    refreshToken: "r",
    issuedAt: "",
    expiresAt: "",
    personId: 42,
    ownerAsiakasId: 8,
    ownerAsiakasName: "Kalle Urho Oy",
    endpoint,
  });

  async function makeContext(global: Partial<GlobalOptions>) {
    const file = join(dir, "credentials.json");
    await createStore(file).save(session("https://api.example.com", "eyJstored"));
    const ctx = await createCliContext({
      credentialsPath: file,
      version: "1.0.0",
      global: { ...EMPTY_GLOBAL, ...global },
    });
    return { ctx, file };
  }

  test("an override with no session of its own is 'not logged in' there — no request, nothing persisted", async () => {
    const { ctx, file } = await makeContext({ endpoint: "http://127.0.0.1:8080" });
    expect(ctx.client).toBeNull();
    expect(ctx.endpoint).toBe("http://127.0.0.1:8080");
    expect(mockFetch).not.toHaveBeenCalled();
    const creds = await createStore(file).load();
    expect(creds?.jwt).toBe("eyJstored");
  });

  test("an override WITH a parked session of its own acts with that session, not the active one", async () => {
    const file = join(dir, "credentials.json");
    const store = createStore(file);
    await store.save(session("https://api.example.com", "eyJprod"), undefined, { activate: true });
    await store.save(session("http://127.0.0.1:8080", "eyJlocal"));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const ctx = await createCliContext({
      credentialsPath: file,
      version: "1.0.0",
      global: { ...EMPTY_GLOBAL, endpoint: "http://127.0.0.1:8080" },
    });
    await ctx.client!.get("/api/thing");
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:8080/api/thing");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer eyJlocal");
  });

  test("a normalization-equal override (trailing slash, case) is the same session and keeps the refresh path", async () => {
    // Original GET → 401, bearer refresh → 200 with a fresh token, retry → 200.
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Token expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "eyJfresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );

    const { ctx, file } = await makeContext({ endpoint: "https://API.example.com/" });
    const result = await ctx.client!.get<{ ok: boolean }>("/api/thing");

    expect(result).toEqual({ ok: true });
    expect(mockFetch.mock.calls[1][0]).toContain("/api/auth/refresh-token");
    const creds = await createStore(file).load();
    expect(creds?.jwt).toBe("eyJfresh");
  });

  test("--endpoint <other> --company <id> never reaches the switch with a foreign token", async () => {
    const { ctx } = await makeContext({ endpoint: "http://127.0.0.1:8080", asiakas: 1349 });
    expect(ctx.client).toBeNull();
    expect(performSwitch).not.toHaveBeenCalled();
  });

  test("a switch 401 on the session's own endpoint propagates untouched", async () => {
    vi.mocked(performSwitch).mockRejectedValue(
      new CliError("Company switch failed: HTTP 401 Invalid Token", 401, null, 2)
    );
    const err = await makeContext({ asiakas: 1349 }).then(
      () => {
        throw new Error("createCliContext did not throw");
      },
      (e) => e as CliError
    );
    expect(err.statusCode).toBe(401);
    expect(err.hint).toBeUndefined();
  });

  test("the 403 branch keeps the fb#311 --company note", async () => {
    vi.mocked(performSwitch).mockRejectedValue(
      new CliError("Company switch failed: HTTP 403 no access", 403, null, 3)
    );
    const err = await makeContext({ asiakas: 1349 }).then(
      () => {
        throw new Error("createCliContext did not throw");
      },
      (e) => e as CliError
    );
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/MEMBER of/);
    expect(err.hint).toBe("");
  });
});
