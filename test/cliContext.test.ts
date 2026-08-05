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
