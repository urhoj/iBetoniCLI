import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliContext } from "../src/cliContext.js";
import { createStore } from "../src/auth/store.js";
import type { GlobalOptions } from "../src/globals.js";

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
